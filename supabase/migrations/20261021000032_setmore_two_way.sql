-- =============================================================================
-- Two-way Setmore sync for feedback sessions:
--   * a time entered or changed in the portal (CAM or QA) books that slot in Setmore
--     with the QA provider; the CAM's old appointment is labelled "Cancelled"
--   * cancelled in the portal -> Setmore label "Cancelled"; completed -> "Complete"
--   * labelled Complete in Setmore -> session Completed in the portal
--   * Setmore is checked every 5 minutes (was 10)
-- Changes that came from Setmore itself are not sent back. Safe to run more than once.
-- =============================================================================
create or replace function public.apply_setmore_appointments(p_rows jsonb, p_from timestamptz)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s record; a jsonb; n_booked int := 0; n_cancel int := 0; n_same int := 0;
begin
  perform set_config('app.setmore_sync', 'on', true);   -- changes made here are not sent back to Setmore
  create temp table _ap on commit drop as
    select x ->> 'key' as key, (x ->> 'start')::timestamptz as start_at, lower(trim(x ->> 'staff_email')) as staff_email,
           lower(trim(x ->> 'customer_email')) as cam_email, lower(coalesce(x ->> 'label', '')) as label
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) x
    where coalesce(x ->> 'key', '') <> '' and coalesce(x ->> 'start', '') <> '';

  for s in
    select fs.id, fs.status, fs.booked_for, fs.booking_source, fs.setmore_key, cam.email as cam_email, c.released_at
    from public.feedback_sessions fs
    join public.feedback_cycles c on c.id = fs.cycle_id
    join public.employees cam on cam.id = fs.cam_id
    where c.released_at is not null and fs.status <> 'completed' and fs.status <> 'no_audit'
      and c.number = (select max(c2.number) from public.feedback_cycles c2 join public.feedback_sessions s2 on s2.cycle_id = c2.id
                       where s2.cam_id = fs.cam_id and c2.released_at is not null)   -- the CAM's current cycle
  loop
    -- the CAM's booking for this cycle: the latest appointment made for a time after the cycle opened
    select to_jsonb(ap) into a from _ap ap
     where ap.cam_email = s.cam_email and ap.start_at >= s.released_at - interval '1 day'
     order by (ap.label like '%cancel%' or ap.label like '%no%show%'), ap.start_at desc limit 1;

    if a is not null and (a ->> 'label') like '%complete%' and s.status = 'booked' then
      -- labelled Complete in Setmore
      update public.feedback_sessions set status = 'completed', completed_at = coalesce(completed_at, now()), booked_for = (a ->> 'start_at')::timestamptz,
             setmore_key = a ->> 'key', updated_at = now() where id = s.id;
      n_booked := n_booked + 1;
    elsif a is not null and not ((a ->> 'label') like '%cancel%' or (a ->> 'label') like '%no%show%') then
      if (s.status = 'booked' or s.status = 'cancelled') and s.setmore_key = (a ->> 'key') and s.booked_for = (a ->> 'start_at')::timestamptz then
        -- unchanged; a booking the CAM cancelled in the portal stays cancelled until a new appointment is made
        n_same := n_same + 1;
      else
        update public.feedback_sessions set status = 'booked', booked_for = (a ->> 'start_at')::timestamptz, booked_at = coalesce(booked_at, now()),
               booking_source = 'setmore', setmore_key = a ->> 'key', booked_with_email = a ->> 'staff_email', updated_at = now()
         where id = s.id;
        n_booked := n_booked + 1;
      end if;
    elsif s.status = 'booked' and (s.booking_source = 'setmore' or s.booking_source = 'sheet')
          and (a is not null or (s.booked_for >= p_from and s.setmore_key is not null)) then
      -- booked in Setmore earlier, now cancelled there (or gone from Setmore)
      update public.feedback_sessions set status = 'cancelled', booking_source = 'setmore', updated_at = now() where id = s.id;
      n_cancel := n_cancel + 1;
    end if;
    a := null;
  end loop;
  perform set_config('app.setmore_sync', 'off', true);
  return jsonb_build_object('booked_or_moved', n_booked, 'cancelled', n_cancel, 'unchanged', n_same, 'appointments', (select count(*) from _ap));
end $$;
revoke execute on function public.apply_setmore_appointments(jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.apply_setmore_appointments(jsonb, timestamptz) to service_role;

create or replace function public._setmore_call(p_body jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform net.http_post(
    url := 'https://fjctcwhhugkvxfsotzjc.supabase.co/functions/v1/setmore',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron', (select value from public.app_secrets where key = 'setmore_cron')),
    body := p_body, timeout_milliseconds := 30000);
end $$;
revoke execute on function public._setmore_call(jsonb) from public, anon, authenticated;

create or replace function public.on_feedback_session_cancelled()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(current_setting('app.setmore_sync', true), '') = 'on' or not public.setmore_connected() then return new; end if;
  if new.status = 'booked' and new.booked_for is not null and new.booking_source in ('cam', 'qa')
     and (old.status is distinct from 'booked' or old.booked_for is distinct from new.booked_for) then
    perform public._setmore_call(jsonb_build_object('action', 'push_booking', 'session', new.id));
  elsif new.status = 'cancelled' and old.status = 'booked' and new.setmore_key is not null then
    perform public._setmore_call(jsonb_build_object('action', 'set_label', 'key', new.setmore_key, 'label', 'Cancelled'));
  elsif new.status = 'completed' and old.status is distinct from 'completed' and new.setmore_key is not null then
    perform public._setmore_call(jsonb_build_object('action', 'set_label', 'key', new.setmore_key, 'label', 'Complete'));
  end if;
  return new;
end $$;
drop trigger if exists feedback_session_cancelled_setmore on public.feedback_sessions;
create trigger feedback_session_cancelled_setmore after update of status, booked_for on public.feedback_sessions
  for each row execute function public.on_feedback_session_cancelled();

select cron.unschedule('csqa-setmore-sync') where exists (select 1 from cron.job where jobname = 'csqa-setmore-sync');
select cron.schedule('csqa-setmore-sync', '*/5 * * * *',
  $c$select net.http_post(url := 'https://fjctcwhhugkvxfsotzjc.supabase.co/functions/v1/setmore',
       headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron', (select value from public.app_secrets where key = 'setmore_cron')),
       body := '{"action":"sync"}'::jsonb, timeout_milliseconds := 60000)$c$);
