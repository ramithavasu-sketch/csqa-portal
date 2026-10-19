-- =============================================================================
-- Team Manager permissions: view every team's and CAM's PUBLISHED results,
-- dashboards, reports, feedback-session status and appeals (read-only; shared
-- comments only). No appeal reviews or decisions, no score changes, no admin.
-- Safe to run more than once.
-- =============================================================================
create or replace function public.is_manager()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() = 'manager', false)
$$;
revoke execute on function public.is_manager() from public, anon;
grant execute on function public.is_manager() to authenticated, service_role;

create or replace function public.can_view_cam(p_cam uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_qa()
      or public.is_manager()
      or p_cam = public.my_employee_id()
      or public.is_lead_of(p_cam)
$$;

create or replace function public.can_view_appeal(p_appeal uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.appeals a
    where a.id = p_appeal
      and (public.is_qa()
           or (public.is_manager() and a.status <> 'draft')
           or a.cam_id = public.my_employee_id()
           or (public.my_role() = 'admin' and (a.lead_id = public.my_employee_id() or public.is_lead_of(a.cam_id))))
  )
$$;

create or replace function public.my_visible_cam_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select e.id from public.employees e where public.is_qa() or public.is_manager()
  union
  select public.my_employee_id() where public.my_employee_id() is not null
  union
  select c.id from public.employees c join public.teams t on t.id = c.team_id
   where public.my_role() = 'admin' and t.lead_id = public.my_employee_id()
$$;

drop policy if exists employees_select on public.employees;
create policy employees_select on public.employees for select to authenticated using (
  public.is_qa()
  or public.is_manager()
  or id = public.my_employee_id()
  or public.is_lead_of(id)
  or role in ('admin', 'super_admin', 'evaluator', 'manager')
);


-- A Team Manager may also lead a team (e.g. the team of Team Leads): they then review that
-- team's appeals like a Lead. Below: the latest bodies with only the role check widened.
create or replace function public.is_lead_of(p_cam uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.employees c
    join public.teams t on t.id = c.team_id
    where c.id = p_cam
      and t.lead_id = public.my_employee_id()
      and public.my_role() in ('admin', 'manager')
  )
$$;

create or replace function public.validate_team_lead()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.lead_id is not null and not exists (
    select 1 from public.employees where id = new.lead_id and role in ('admin', 'manager', 'super_admin') and status = 'active') then
    raise exception 'A Team Lead must be an active Team Lead or Team Manager account';
  end if;
  return new;
end $$;

-- lead_review_appeal (from 20261007000008_brief_gaps.sql)
create or replace function public.lead_review_appeal(
  p_appeal uuid, p_recommendation public.lead_recommendation, p_comment text,
  p_internal_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  me public.employees := public._me();
  a public.appeals;
  v_days int := coalesce((public.get_setting('sla') ->> 'clarification_days')::int, 2);
begin
  select * into a from public.appeals where id = p_appeal for update;
  if a.id is null then raise exception 'Appeal not found'; end if;
  if me.role not in ('admin', 'manager') or not (a.lead_id = me.id or public.is_lead_of(a.cam_id)) then
    raise exception 'Only the CAM''s Team Lead can review this appeal' using errcode = '42501';
  end if;
  if a.status <> 'pending_lead_review' then
    raise exception 'This appeal is not awaiting Lead review (current status: %)', a.status;
  end if;
  if p_comment is null or length(trim(p_comment)) < 5 then
    raise exception 'Please add a comment for your recommendation';
  end if;

  if p_internal_note is not null and length(trim(p_internal_note)) > 0 then
    perform public._appeal_event(p_appeal, me, 'comment', p_internal_note, 'internal', null, null);
  end if;

  if p_recommendation = 'request_more_info' then
    update public.appeals set info_requested_from = 'cam',
      info_due_at = public.add_business_days(now(), v_days) where id = p_appeal;
    perform public._set_appeal_status(p_appeal, 'returned_to_cam');
    perform public._appeal_event(p_appeal, me, 'lead_returned', p_comment, 'shared',
                                 'pending_lead_review', 'returned_to_cam', p_recommendation);
    perform public.notify(a.cam_id, 'appeal_returned', 'Appeal ' || a.reference || ' returned for clarification',
      public._appeal_msg(p_appeal, 'Your Team Lead has requested more information. Please respond by '
        || to_char(public.add_business_days(now(), v_days), 'DD Mon YYYY') || '.'),
      '/appeals/' || p_appeal, p_appeal);
  else
    update public.appeals set lead_recommendation = p_recommendation, forwarded_at = now(),
      info_requested_from = null, info_due_at = null where id = p_appeal;
    perform public._set_appeal_status(p_appeal, 'pending_qa_review');
    perform public._appeal_event(p_appeal, me, 'lead_forwarded', p_comment, 'shared',
                                 'pending_lead_review', 'pending_qa_review', p_recommendation);
    perform public.notify_super_admins('appeal_forwarded', 'Appeal ' || a.reference || ' forwarded to QA',
      public._appeal_msg(p_appeal, 'The Team Lead has reviewed this appeal and forwarded it to QA.'), '/appeals/' || p_appeal, p_appeal);
    perform public.notify(a.cam_id, 'appeal_forwarded', 'Appeal ' || a.reference || ' forwarded to QA',
      public._appeal_msg(p_appeal, 'Your Team Lead has reviewed your appeal and forwarded it to QA.'), '/appeals/' || p_appeal, p_appeal);
  end if;
end $$;

-- respond_to_appeal_request (from 20261007000008_brief_gaps.sql)
create or replace function public.respond_to_appeal_request(p_appeal uuid, p_response text)
returns void language plpgsql security definer set search_path = public as $$
declare
  me public.employees := public._me();
  a public.appeals;
begin
  select * into a from public.appeals where id = p_appeal for update;
  if a.id is null then raise exception 'Appeal not found'; end if;
  if p_response is null or length(trim(p_response)) < 5 then raise exception 'Please enter a response'; end if;

  if a.status = 'returned_to_cam' then
    if a.cam_id <> me.id then raise exception 'Only the CAM can respond' using errcode = '42501'; end if;
    update public.appeals set info_requested_from = null, info_due_at = null where id = p_appeal;
    perform public._set_appeal_status(p_appeal, 'pending_lead_review');
    perform public._appeal_event(p_appeal, me, 'cam_responded', p_response, 'shared', 'returned_to_cam', 'pending_lead_review');
    perform public.notify(a.lead_id, 'appeal_submitted', 'CAM responded on appeal ' || a.reference,
      public._appeal_msg(p_appeal, 'The CAM has provided the requested information.'), '/appeals/' || p_appeal, p_appeal);
  elsif a.status = 'pending_additional_info' then
    if (a.info_requested_from = 'cam' and a.cam_id <> me.id)
       or (a.info_requested_from = 'lead' and not (me.role in ('admin', 'manager') and (a.lead_id = me.id or public.is_lead_of(a.cam_id)))) then
      raise exception 'You are not the person QA requested information from' using errcode = '42501';
    end if;
    update public.appeals set info_requested_from = null, info_due_at = null where id = p_appeal;
    perform public._set_appeal_status(p_appeal, 'pending_qa_review');
    perform public._appeal_event(p_appeal, me, case when me.id = a.cam_id then 'cam_responded' else 'lead_responded' end,
                                 p_response, 'shared', 'pending_additional_info', 'pending_qa_review');
    perform public.notify_super_admins('appeal_forwarded', 'Response received on appeal ' || a.reference,
      public._appeal_msg(p_appeal, 'The requested information has been provided.'), '/appeals/' || p_appeal, p_appeal);
  else
    raise exception 'No information has been requested on this appeal';
  end if;
end $$;
