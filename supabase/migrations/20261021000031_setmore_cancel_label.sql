-- =============================================================================
-- A Setmore-booked session cancelled in the portal (by the CAM or QA) gets its
-- Setmore appointment labelled "Cancelled" (via the `setmore` function). The
-- 10-minute sync then reads that label back and keeps the session Cancelled
-- until the CAM books a new slot. Safe to run more than once.
-- =============================================================================
create or replace function public.on_feedback_session_cancelled()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'cancelled' and old.status = 'booked' and new.setmore_key is not null and public.setmore_connected() then
    perform net.http_post(
      url := 'https://fjctcwhhugkvxfsotzjc.supabase.co/functions/v1/setmore',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron', (select value from public.app_secrets where key = 'setmore_cron')),
      body := jsonb_build_object('action', 'cancel_label', 'key', new.setmore_key),
      timeout_milliseconds := 30000);
  end if;
  return new;
end $$;
drop trigger if exists feedback_session_cancelled_setmore on public.feedback_sessions;
create trigger feedback_session_cancelled_setmore after update of status on public.feedback_sessions
  for each row execute function public.on_feedback_session_cancelled();
