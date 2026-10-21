-- =============================================================================
-- Sheet clean-up: also remove leftover copies in a draft week that has no sheet
-- rows with a task link any more, when the same task + CAM is now under another week (a row whose
-- QA Week was corrected), then the empty week itself. Safe to run more than once.
-- =============================================================================
create or replace function public.reconcile_evaluations(p_weeks text[], p_keys jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  w record; e record; n_week int; n_gone int; removed jsonb := '[]'::jsonb; kept jsonb := '[]'::jsonb; skipped jsonb := '[]'::jsonb;
  v_from date; n_left int; weeks_removed jsonb := '[]'::jsonb;
begin
  create temp table _keys (link text, cam text, week text) on commit drop;
  insert into _keys select k ->> 0, lower(trim(k ->> 1)), trim(k ->> 2) from jsonb_array_elements(coalesce(p_keys, '[]'::jsonb)) k;

  for w in select p.id, p.label from public.reporting_periods p where p.label = any (p_weeks) and not p.is_demo loop
    if not exists (select 1 from _keys where week = w.label) then
      skipped := skipped || jsonb_build_array(w.label || ': no sheet rows sent'); continue;
    end if;
    select count(*) into n_week from public.evaluations where period_id = w.id and not is_demo;
    select count(*) into n_gone from public.evaluations ev join public.employees c on c.id = ev.cam_id
     where ev.period_id = w.id and not ev.is_demo
       and not exists (select 1 from _keys k where k.week = w.label and k.link = ev.task_link and k.cam = c.email);
    if n_gone = 0 then continue; end if;
    if n_gone > greatest(1, n_week / 10) then
      skipped := skipped || jsonb_build_array(w.label || ': ' || n_gone || ' of ' || n_week || ' not in the sheet — too many, nothing removed');
      continue;
    end if;
    for e in select ev.id, ev.task_link, c.email from public.evaluations ev join public.employees c on c.id = ev.cam_id
              where ev.period_id = w.id and not ev.is_demo
                and not exists (select 1 from _keys k where k.week = w.label and k.link = ev.task_link and k.cam = c.email) loop
      if exists (select 1 from public.appeals where evaluation_id = e.id)
         or exists (select 1 from public.score_adjustments where evaluation_id = e.id)
         or exists (select 1 from public.appeal_resubmission_grants where evaluation_id = e.id) then
        kept := kept || jsonb_build_array(jsonb_build_object('week', w.label, 'cam', e.email, 'task_link', e.task_link));
        continue;
      end if;
      insert into public.audit_logs (actor_id, action, table_name, record_id, previous)
      select null, 'sheet_reconcile_removed', 'evaluations', ev.id::text,
             to_jsonb(ev) || jsonb_build_object('scores', (select jsonb_agg(to_jsonb(s)) from public.evaluation_scores s where s.evaluation_id = ev.id))
        from public.evaluations ev where ev.id = e.id;
      perform set_config('app.allow_evaluation_purge', 'on', true);
      delete from public.evaluations where id = e.id;
      perform set_config('app.allow_evaluation_purge', 'off', true);
      removed := removed || jsonb_build_array(jsonb_build_object('week', w.label, 'cam', e.email, 'task_link', e.task_link));
    end loop;
  end loop;

  -- Draft weeks with no sheet rows any more (e.g. a row typed as WK-43, then corrected to WK-42): an audit
  -- there whose task + CAM is now in the sheet under another week is a leftover copy and is removed;
  -- the week is removed once it is empty. Audits not found elsewhere in the sheet are left alone.
  select min(p.start_date) into v_from from public.reporting_periods p where p.label = any (p_weeks) and not p.is_demo;
  for w in select p.id, p.label from public.reporting_periods p
            where v_from is not null and p.start_date >= v_from and p.status = 'draft' and not p.is_demo
              and not exists (select 1 from _keys k where k.week = p.label) loop   -- not in the sheet, or no rows with a task link
    for e in select ev.id, ev.task_link, c.email from public.evaluations ev join public.employees c on c.id = ev.cam_id
              where ev.period_id = w.id and not ev.is_demo
                and exists (select 1 from _keys k where k.link = ev.task_link and k.cam = c.email and k.week <> w.label) loop
      if exists (select 1 from public.appeals where evaluation_id = e.id)
         or exists (select 1 from public.score_adjustments where evaluation_id = e.id)
         or exists (select 1 from public.appeal_resubmission_grants where evaluation_id = e.id) then
        kept := kept || jsonb_build_array(jsonb_build_object('week', w.label, 'cam', e.email, 'task_link', e.task_link));
        continue;
      end if;
      insert into public.audit_logs (actor_id, action, table_name, record_id, previous)
      select null, 'sheet_reconcile_removed', 'evaluations', ev.id::text,
             to_jsonb(ev) || jsonb_build_object('note', 'moved to another week in the sheet',
                                                'scores', (select jsonb_agg(to_jsonb(s)) from public.evaluation_scores s where s.evaluation_id = ev.id))
        from public.evaluations ev where ev.id = e.id;
      perform set_config('app.allow_evaluation_purge', 'on', true);
      delete from public.evaluations where id = e.id;
      perform set_config('app.allow_evaluation_purge', 'off', true);
      removed := removed || jsonb_build_array(jsonb_build_object('week', w.label, 'cam', e.email, 'task_link', e.task_link));
    end loop;
    select count(*) into n_left from public.evaluations where period_id = w.id;
    if n_left = 0 and not exists (select 1 from public.weekly_report_emails where period_id = w.id)
       and not exists (select 1 from public.scorecard_emails where period_id = w.id)
       and not exists (select 1 from public.feedback_cycles where w.id = any (period_ids)) then
      insert into public.audit_logs (actor_id, action, table_name, record_id, previous)
      select null, 'sheet_reconcile_week_removed', 'reporting_periods', p.id::text, to_jsonb(p) from public.reporting_periods p where p.id = w.id;
      delete from public.reporting_periods where id = w.id;
      weeks_removed := weeks_removed || to_jsonb(w.label);
    end if;
  end loop;
  return jsonb_build_object('removed', removed, 'kept_with_appeal', kept, 'skipped', skipped, 'weeks_removed', weeks_removed);
end $$;
revoke execute on function public.reconcile_evaluations(text[], jsonb) from public, anon, authenticated;
grant execute on function public.reconcile_evaluations(text[], jsonb) to service_role;

revoke execute on function public.reconcile_evaluations(text[], jsonb) from public, anon, authenticated;
grant execute on function public.reconcile_evaluations(text[], jsonb) to service_role;
