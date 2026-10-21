-- Run the Setmore booking sync every 10 minutes (database scheduler → `setmore` function).
-- The shared key lives in public.app_secrets('setmore_cron'), readable only by the database
-- and server functions; create it once with a long random value before running this.
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.unschedule('csqa-setmore-sync') where exists (select 1 from cron.job where jobname = 'csqa-setmore-sync');
select cron.schedule('csqa-setmore-sync', '*/10 * * * *', $$
  select net.http_post(
    url := 'https://fjctcwhhugkvxfsotzjc.supabase.co/functions/v1/setmore',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron', (select value from public.app_secrets where key = 'setmore_cron')),
    body := '{"action":"sync"}'::jsonb,
    timeout_milliseconds := 60000);
$$);
