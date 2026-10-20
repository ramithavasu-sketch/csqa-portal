-- =============================================================================
-- Portal feedback: anyone signed in can send feedback about the portal (bug,
-- idea, question, other) from the Feedback button. It is stored, and emailed to
-- the address in settings.notifications.portal_feedback_to (sent by the sheet
-- script like other portal emails), with Reply-To set to the sender.
-- Super Admins can read all feedback in the portal. Safe to run more than once.
-- =============================================================================
create table if not exists public.portal_feedback (
  id          uuid primary key default gen_random_uuid(),
  employee_id uuid references public.employees (id),
  kind        text not null check (kind in ('bug', 'idea', 'question', 'other')),
  rating      int check (rating between 1 and 5),
  message     text not null,
  page        text,
  status      text not null default 'new' check (status in ('new', 'done')),
  created_at  timestamptz not null default now()
);
alter table public.portal_feedback enable row level security;
drop policy if exists portal_feedback_select on public.portal_feedback;
create policy portal_feedback_select on public.portal_feedback for select to authenticated
  using ((select public.is_super_admin()) or employee_id = (select public.my_employee_id()));
grant select on public.portal_feedback to authenticated;

create or replace function public.submit_portal_feedback(p_kind text, p_message text, p_page text default null, p_rating int default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  me public.employees := public._me();
  v_to text := nullif(trim(coalesce(public.get_setting('notifications') ->> 'portal_feedback_to', '')), '');
  v_id uuid; v_label text; v_msg text := trim(coalesce(p_message, ''));
begin
  if me.id is null then raise exception 'Sign in to send feedback' using errcode = '42501'; end if;
  if p_kind not in ('bug', 'idea', 'question', 'other') then raise exception 'Choose a feedback type'; end if;
  if length(v_msg) < 5 then raise exception 'Write a few words about your feedback'; end if;
  if length(v_msg) > 4000 then raise exception 'Keep feedback under 4,000 characters'; end if;
  if (select count(*) from public.portal_feedback where employee_id = me.id and created_at > now() - interval '1 hour') >= 10 then
    raise exception 'You have sent a lot of feedback in the last hour — please try again later';
  end if;
  insert into public.portal_feedback (employee_id, kind, rating, message, page)
  values (me.id, p_kind, case when p_rating between 1 and 5 then p_rating end, v_msg, left(nullif(trim(coalesce(p_page, '')), ''), 300))
  returning id into v_id;

  if v_to is not null then
    v_label := case p_kind when 'bug' then 'Problem' when 'idea' then 'Idea' when 'question' then 'Question' else 'Feedback' end;
    insert into public.email_outbox (recipient_email, reply_to, subject, body_text, body_html, kind)
    values (v_to, me.email,
      'Portal feedback · ' || v_label || ' · ' || me.full_name,
      'From: ' || me.full_name || ' <' || me.email || '> (' || me.role::text || ')' || E'\n' ||
      'Type: ' || v_label || coalesce(E'\nRating: ' || p_rating || '/5', '') || coalesce(E'\nPage: ' || p_page, '') || E'\n\n' || v_msg,
      '<p><b>From:</b> ' || public._html_escape(me.full_name) || ' &lt;' || public._html_escape(me.email) || '&gt; (' || me.role::text || ')<br>' ||
      '<b>Type:</b> ' || v_label || coalesce('<br><b>Rating:</b> ' || p_rating || '/5', '') ||
      coalesce('<br><b>Page:</b> ' || public._html_escape(p_page), '') || '</p><p style="white-space:pre-wrap">' || public._html_escape(v_msg) || '</p>' ||
      '<p style="color:#666">Reply to this email to answer ' || public._html_escape(split_part(me.full_name, ' ', 1)) || ' directly.</p>',
      'notification');
  end if;
  return v_id;
end $$;
revoke execute on function public.submit_portal_feedback(text, text, text, int) from public, anon;
grant execute on function public.submit_portal_feedback(text, text, text, int) to authenticated;

-- Super Admin: mark feedback handled (or new again).
create or replace function public.set_portal_feedback_status(p_id uuid, p_status text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_super_admin() then raise exception 'Only a Super Admin can do this' using errcode = '42501'; end if;
  if p_status not in ('new', 'done') then raise exception 'Unknown status'; end if;
  update public.portal_feedback set status = p_status where id = p_id;
end $$;
revoke execute on function public.set_portal_feedback_status(uuid, text) from public, anon;
grant execute on function public.set_portal_feedback_status(uuid, text) to authenticated;

-- Super Admin: list with the sender's name.
create or replace function public.list_portal_feedback()
returns table (id uuid, created_at timestamptz, kind text, rating int, message text, page text, status text, sender_name text, sender_email text, sender_role text)
language sql stable security definer set search_path = public as $$
  select f.id, f.created_at, f.kind, f.rating, f.message, f.page, f.status, e.full_name, e.email, e.role::text
  from public.portal_feedback f left join public.employees e on e.id = f.employee_id
  where public.is_super_admin()
  order by f.created_at desc
  limit 500
$$;
revoke execute on function public.list_portal_feedback() from public, anon;
grant execute on function public.list_portal_feedback() to authenticated;
