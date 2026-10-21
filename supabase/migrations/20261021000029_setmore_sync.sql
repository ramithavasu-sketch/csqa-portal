-- =============================================================================
-- Feedback-session bookings straight from Setmore (replaces the "Booked Sessions"
-- sheet once connected). Every 10 minutes the `setmore` function reads the
-- feedback-session appointments and apply_setmore_appointments() matches each
-- one to the CAM by email:
--   * appointment found          -> session Booked, at that time, with that QA member
--   * a Setmore booking we had    -> gone from Setmore (cancelled/deleted) -> Cancelled
--   * label containing "cancel" / "no show" -> Cancelled
-- A completed session is never changed. Safe to run more than once.
-- =============================================================================
alter table public.feedback_sessions add column if not exists setmore_key text;
alter table public.feedback_sessions add column if not exists booked_with_email text;

-- Values only the database and server functions can read (RLS on, no policies).
create table if not exists public.app_secrets (key text primary key, value text not null, updated_at timestamptz not null default now());
alter table public.app_secrets enable row level security;
revoke all on public.app_secrets from anon, authenticated;

-- p_rows: [{key, start, staff_email, customer_email, label}], p_from: start of the window searched
create or replace function public.apply_setmore_appointments(p_rows jsonb, p_from timestamptz)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s record; a jsonb; n_booked int := 0; n_cancel int := 0; n_same int := 0;
begin
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

    if a is not null and not ((a ->> 'label') like '%cancel%' or (a ->> 'label') like '%no%show%') then
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
  return jsonb_build_object('booked_or_moved', n_booked, 'cancelled', n_cancel, 'unchanged', n_same, 'appointments', (select count(*) from _ap));
end $$;
revoke execute on function public.apply_setmore_appointments(jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.apply_setmore_appointments(jsonb, timestamptz) to service_role;

-- Once Setmore is connected, the sheet's "Booked Sessions" rows are ignored (Setmore is the source).
create or replace function public.setmore_connected()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((public.get_setting('setmore') ->> 'connected')::boolean, false)
$$;


-- ingest_feedback_bookings (from 20261010000021): skipped once Setmore is connected
create or replace function public.ingest_feedback_bookings(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r jsonb; v_at timestamptz; v_name text; v_prov text; v_status text; v_sess uuid; v_cur text; v_booked timestamptz;
  n_upd int := 0; n_same int := 0; unmatched jsonb := '[]'::jsonb; to_cancel jsonb := '[]'::jsonb;
begin
  if public.setmore_connected() then
    return jsonb_build_object('updated', 0, 'unchanged', 0, 'unmatched', '[]'::jsonb, 'cancel_rows', '[]'::jsonb, 'note', 'Setmore is connected; bookings come from Setmore');
  end if;
  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    begin v_at := (r ->> 'date')::timestamptz; exception when others then v_at := null; end;
    v_name := lower(regexp_replace(trim(coalesce(r ->> 'cam_name', '')), '\s+', ' ', 'g'));
    v_prov := lower(split_part(trim(coalesce(r ->> 'provider_name', '')), ' ', 1));
    v_status := lower(trim(coalesce(r ->> 'status', '')));
    if v_at is null or v_name = '' then continue; end if;

    select s.id, s.status, s.booked_for into v_sess, v_cur, v_booked
    from public.feedback_sessions s
    join public.feedback_cycles c on c.id = s.cycle_id
    join public.employees cam on cam.id = s.cam_id
    where c.released_at is not null and c.released_at::date <= v_at::date + 1
      and (lower(cam.full_name) = v_name
           or (split_part(lower(cam.full_name), ' ', 1) = split_part(v_name, ' ', 1)
               and lower(split_part(coalesce(s.provider_name, ''), ' ', 1)) = v_prov
               and (select count(*) from public.feedback_sessions s2 join public.employees e2 on e2.id = s2.cam_id
                     where s2.cycle_id = s.cycle_id and split_part(lower(e2.full_name), ' ', 1) = split_part(v_name, ' ', 1)
                       and lower(split_part(coalesce(s2.provider_name, ''), ' ', 1)) = v_prov) = 1))
    order by c.number desc, (lower(cam.full_name) = v_name) desc
    limit 1;

    if v_sess is null then
      unmatched := unmatched || jsonb_build_array(r ->> 'cam_name');
      continue;
    end if;

    if v_cur = 'completed' then
      n_same := n_same + 1;
    elsif v_cur = 'cancelled' and v_booked = v_at and v_status not like '%complete%' then
      -- cancelled in the portal: this sheet row must say so too
      if v_status not like '%cancel%' and r ? 'row' then to_cancel := to_cancel || jsonb_build_array((r ->> 'row')::int); end if;
      n_same := n_same + 1;
    elsif v_status like '%complete%' then
      update public.feedback_sessions set status = 'completed', completed_at = coalesce(completed_at, v_at), booked_for = v_at,
             booking_source = 'sheet', updated_at = now() where id = v_sess;
      n_upd := n_upd + 1;
    elsif v_status like '%cancel%' then
      update public.feedback_sessions set status = 'cancelled', booking_source = 'sheet', updated_at = now()
       where id = v_sess and status = 'booked' and booked_for = v_at;   -- only the booking this row made
      if found then n_upd := n_upd + 1; else n_same := n_same + 1; end if;
    elsif v_status like '%no%show%' then
      update public.feedback_sessions set status = 'cancelled', booked_for = v_at, booking_source = 'sheet', updated_at = now()
       where id = v_sess and status is distinct from 'cancelled';
      if found then n_upd := n_upd + 1; else n_same := n_same + 1; end if;
    else   -- booked / confirmed / pending / blank (a new time after a cancellation books again)
      update public.feedback_sessions set status = 'booked', booked_for = v_at, booked_at = coalesce(booked_at, now()), booking_source = 'sheet', updated_at = now()
       where id = v_sess and (status <> 'booked' or booked_for is distinct from v_at);
      if found then n_upd := n_upd + 1; else n_same := n_same + 1; end if;
    end if;
    v_sess := null; v_cur := null; v_booked := null;
  end loop;
  return jsonb_build_object('updated', n_upd, 'unchanged', n_same, 'unmatched', unmatched, 'cancel_rows', to_cancel);
end $$;


-- sessions list: also who the CAM booked with in Setmore
drop function if exists public.list_feedback_sessions(uuid);
create function public.list_feedback_sessions(p_cycle uuid default null)
returns table (id uuid, cycle_id uuid, cycle_number int, book_by date, cam_id uuid, cam_name text, cam_email text,
               lead_id uuid, lead_name text, provider_id uuid, provider_name text, provider_auto boolean, weeks jsonb,
               status text, booked_for timestamptz, booked_at timestamptz, completed_at timestamptz, booking_source text, booked_with_name text)
language sql stable security definer set search_path = public as $$
  select s.id, s.cycle_id, c.number, c.book_by, s.cam_id, cam.full_name, cam.email, s.lead_id, ld.full_name,
         s.provider_id, s.provider_name, s.provider_auto, s.weeks, s.status, s.booked_for, s.booked_at, s.completed_at, s.booking_source,
         (select w.full_name from public.employees w where w.email = s.booked_with_email)
  from public.feedback_sessions s
  join public.feedback_cycles c on c.id = s.cycle_id
  join public.employees cam on cam.id = s.cam_id
  left join public.employees ld on ld.id = s.lead_id
  where (p_cycle is null or s.cycle_id = p_cycle)
    and (public.is_qa()
         or (c.released_at is not null
             and (s.cam_id in (select public.my_visible_cam_ids()) or s.lead_id = public.my_employee_id())))
  order by c.number desc, cam.full_name
$$;
revoke execute on function public.list_feedback_sessions(uuid) from public, anon;
grant execute on function public.list_feedback_sessions(uuid) to authenticated;
