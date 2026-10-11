-- =============================================================================
-- Weekly overall scorecard email ("Task Audit Scorecard - WK-nn"): built in the
-- portal from the week's audits, previewed / opened in the browser, and sent by
-- QA with a confirmation step (never on publish). Sent by the sheet script from
-- the configured address (e.g. a shared QA mailbox set up as a Gmail alias).
-- Recipients live in settings (not in this file). Safe to run more than once.
-- =============================================================================
alter table public.email_outbox drop constraint if exists email_outbox_kind_check;
alter table public.email_outbox add constraint email_outbox_kind_check
  check (kind in ('notification', 'weekly_report', 'auth', 'scorecard'));
alter table public.email_outbox add column if not exists from_email text;
alter table public.email_outbox add column if not exists from_name text;

insert into public.settings (key, value, description) values ('scorecard',
  '{"from_email": "", "from_name": "quality assurance", "to": "", "cc": "", "chat_lead_id": null}'::jsonb,
  'Weekly overall scorecard email: sender, default recipients and the Team Lead whose CAMs form the Chat Team table')
on conflict (key) do nothing;

create table if not exists public.scorecard_emails (
  id          uuid primary key default gen_random_uuid(),
  period_id   uuid not null references public.reporting_periods (id),
  outbox_id   uuid references public.email_outbox (id) on delete set null,
  recipients  text not null,
  created_by  uuid references public.employees (id),
  created_at  timestamptz not null default now()
);
alter table public.scorecard_emails enable row level security;
drop policy if exists scorecard_emails_select on public.scorecard_emails;
create policy scorecard_emails_select on public.scorecard_emails for select to authenticated using ((select public.is_qa()));
grant select on public.scorecard_emails to authenticated;

-- QA: queue the scorecard for the sheet script to send.
create or replace function public.queue_scorecard_email(p_period uuid, p_subject text, p_html text, p_text text, p_to text, p_cc text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  cfg jsonb := coalesce(public.get_setting('scorecard'), '{}'::jsonb);
  p public.reporting_periods;
  v_to text := lower(regexp_replace(coalesce(p_to, ''), '[\s;]+', ',', 'g'));
  v_cc text := nullif(lower(regexp_replace(coalesce(p_cc, ''), '[\s;]+', ',', 'g')), '');
  a text; v_out uuid;
begin
  if not public.is_qa() then raise exception 'Only QA can send the weekly scorecard' using errcode = '42501'; end if;
  select * into p from public.reporting_periods where id = p_period;
  if p.id is null then raise exception 'Audit week not found'; end if;
  if p.status <> 'published' then raise exception 'Publish % before sending its scorecard', p.short_label; end if;
  v_to := trim(both ',' from regexp_replace(v_to, ',+', ',', 'g'));
  v_cc := nullif(trim(both ',' from regexp_replace(coalesce(v_cc, ''), ',+', ',', 'g')), '');
  if v_to = '' then raise exception 'Add at least one recipient in To'; end if;
  foreach a in array string_to_array(v_to || coalesce(',' || v_cc, ''), ',') loop
    if a !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Not a valid email address: %', a; end if;
  end loop;
  if coalesce(trim(p_subject), '') = '' or coalesce(p_html, '') = '' then raise exception 'The scorecard is empty'; end if;
  if length(p_html) > 900000 then raise exception 'The scorecard is too large to email'; end if;

  insert into public.email_outbox (recipient_email, cc_email, subject, body_text, body_html, kind, from_email, from_name)
  values (v_to, v_cc, left(p_subject, 300), coalesce(p_text, ''), p_html, 'scorecard',
          nullif(cfg ->> 'from_email', ''), nullif(cfg ->> 'from_name', ''))
  returning id into v_out;
  insert into public.scorecard_emails (period_id, outbox_id, recipients, created_by)
  values (p_period, v_out, v_to || coalesce(' | cc ' || v_cc, ''), public.my_employee_id());
  insert into public.audit_logs (actor_id, action, table_name, record_id, new_value)
  values (public.my_employee_id(), 'scorecard_queued', 'reporting_periods', p_period::text, jsonb_build_object('to', v_to, 'cc', v_cc));
  return v_out;
end $$;
revoke execute on function public.queue_scorecard_email(uuid, text, text, text, text, text) from public, anon;
grant execute on function public.queue_scorecard_email(uuid, text, text, text, text, text) to authenticated;

-- QA: when this week's scorecard was sent, and its delivery status.
create or replace function public.scorecard_history(p_period uuid)
returns table (id uuid, created_at timestamptz, created_by_name text, recipients text, status text, sent_at timestamptz, last_error text)
language sql stable security definer set search_path = public as $$
  select s.id, s.created_at, e.full_name, s.recipients, o.status, o.sent_at, o.last_error
  from public.scorecard_emails s
  left join public.email_outbox o on o.id = s.outbox_id
  left join public.employees e on e.id = s.created_by
  where public.is_qa() and s.period_id = p_period
  order by s.created_at desc
$$;
revoke execute on function public.scorecard_history(uuid) from public, anon;
grant execute on function public.scorecard_history(uuid) to authenticated;
