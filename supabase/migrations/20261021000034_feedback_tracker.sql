-- =============================================================================
-- Portal feedback becomes a tracker: each item moves New -> In pipeline ->
-- In progress -> Fixed (or Won't do), with a note from QA and the date it was
-- fixed. The sender can see the stage of what they sent. Old 'done' = Fixed.
-- Safe to run more than once.
-- =============================================================================
alter table public.portal_feedback drop constraint if exists portal_feedback_status_check;
update public.portal_feedback set status = 'fixed' where status = 'done';
alter table public.portal_feedback add constraint portal_feedback_status_check
  check (status in ('new', 'planned', 'in_progress', 'fixed', 'declined'));
alter table public.portal_feedback add column if not exists admin_note text;
alter table public.portal_feedback add column if not exists status_changed_at timestamptz;
alter table public.portal_feedback add column if not exists resolved_at timestamptz;
update public.portal_feedback set resolved_at = coalesce(resolved_at, created_at) where status = 'fixed';

drop function if exists public.set_portal_feedback_status(uuid, text);
create or replace function public.set_portal_feedback_status(p_id uuid, p_status text, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_super_admin() then raise exception 'Only a Super Admin can do this' using errcode = '42501'; end if;
  if p_status not in ('new', 'planned', 'in_progress', 'fixed', 'declined') then raise exception 'Unknown status'; end if;
  update public.portal_feedback
     set status_changed_at = case when status is distinct from p_status then now() else status_changed_at end,
         resolved_at = case when p_status in ('fixed', 'declined') then coalesce(case when status = p_status then resolved_at end, now()) else null end,
         status = p_status,
         admin_note = case when p_note is null then admin_note else nullif(left(trim(p_note), 2000), '') end
   where id = p_id;
end $$;
revoke execute on function public.set_portal_feedback_status(uuid, text, text) from public, anon;
grant execute on function public.set_portal_feedback_status(uuid, text, text) to authenticated;

drop function if exists public.list_portal_feedback();
create function public.list_portal_feedback()
returns table (id uuid, created_at timestamptz, kind text, rating int, message text, page text, status text, admin_note text,
               status_changed_at timestamptz, resolved_at timestamptz, sender_name text, sender_email text, sender_role text)
language sql stable security definer set search_path = public as $$
  select f.id, f.created_at, f.kind, f.rating, f.message, f.page, f.status, f.admin_note, f.status_changed_at, f.resolved_at, e.full_name, e.email, e.role::text
  from public.portal_feedback f left join public.employees e on e.id = f.employee_id
  where public.is_super_admin()
  order by f.created_at desc
  limit 1000
$$;
revoke execute on function public.list_portal_feedback() from public, anon;
grant execute on function public.list_portal_feedback() to authenticated;

-- the sender's own feedback and where it is
create or replace function public.my_portal_feedback()
returns table (id uuid, created_at timestamptz, kind text, message text, status text, admin_note text, resolved_at timestamptz)
language sql stable security definer set search_path = public as $$
  select f.id, f.created_at, f.kind, f.message, f.status, f.admin_note, f.resolved_at
  from public.portal_feedback f where f.employee_id = public.my_employee_id()
  order by f.created_at desc limit 50
$$;
revoke execute on function public.my_portal_feedback() from public, anon;
grant execute on function public.my_portal_feedback() to authenticated;
