-- =============================================================================
-- The audit sheet is the source of truth for recent weeks. The sheet script sends
-- the (task link, CAM, week) of every row in the last few weeks; portal audits in
-- those weeks that are no longer in the sheet (link corrected, row deleted, row
-- moved to another week) are removed — unless they have an appeal, a resubmission
-- grant or a score adjustment (reported instead). Safety: a week with no sheet
-- rows is skipped, and a week where more than 10% would be removed is left alone.
-- Also: resync_evaluations() now corrects the audit time when it was edited.
-- Safe to run more than once.
-- =============================================================================
create or replace function public.reconcile_evaluations(p_weeks text[], p_keys jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  w record; e record; n_week int; n_gone int; removed jsonb := '[]'::jsonb; kept jsonb := '[]'::jsonb; skipped jsonb := '[]'::jsonb;
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
  return jsonb_build_object('removed', removed, 'kept_with_appeal', kept, 'skipped', skipped);
end $$;
revoke execute on function public.reconcile_evaluations(text[], jsonb) from public, anon, authenticated;
grant execute on function public.reconcile_evaluations(text[], jsonb) to service_role;

-- p_rows: mapper ImportRow objects (same as import_evaluations). Service role only.
create or replace function public.resync_evaluations(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r jsonb; s jsonb; e public.evaluations; v_cam uuid; v_period uuid;
  v_af boolean; v_score numeric; v_fcr text; v_fb text; v_at timestamptz;
  v_old jsonb; v_new_scores jsonb; v_old_scores jsonb;
  n_upd int := 0; n_same int := 0; conflicts jsonb := '[]'::jsonb;
begin
  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    select id into v_cam from public.employees where email = lower(coalesce(r ->> 'cam_email', ''));
    select id into v_period from public.reporting_periods where label = r -> 'period' ->> 'label';
    if v_cam is null or v_period is null then continue; end if;
    select * into e from public.evaluations where task_link = r ->> 'task_link' and cam_id = v_cam and period_id = v_period;
    if e.id is null then continue; end if;

    v_af := coalesce((r ->> 'autofail')::boolean, false);
    v_score := (r ->> 'score')::numeric;
    v_fcr := nullif(r ->> 'fcr', '');
    v_fb := nullif(r ->> 'feedback', '');
    v_at := coalesce((r ->> 'audited_at')::timestamptz, e.audited_at);
    select coalesce(jsonb_object_agg(x ->> 'parameter_id', nullif(x ->> 'earned', '')::numeric), '{}'::jsonb) into v_new_scores
      from jsonb_array_elements(coalesce(r -> 'scores', '[]'::jsonb)) x;
    select coalesce(jsonb_object_agg(parameter_id::text, earned), '{}'::jsonb) into v_old_scores
      from public.evaluation_scores where evaluation_id = e.id;

    if e.autofail = v_af and e.original_score = v_score and e.fcr is not distinct from v_fcr
       and e.feedback is not distinct from v_fb and e.audited_at = v_at and v_old_scores @> v_new_scores and v_new_scores @> v_old_scores then
      n_same := n_same + 1; continue;
    end if;

    if exists (select 1 from public.appeals a where a.evaluation_id = e.id and a.status <> 'draft')
       or exists (select 1 from public.score_adjustments sa where sa.evaluation_id = e.id) then
      conflicts := conflicts || jsonb_build_array(jsonb_build_object('row', r ->> 'row_number', 'task_link', e.task_link, 'cam', r ->> 'cam_email',
        'reason', 'changed in the sheet but this task has an appeal or a QA score correction — not overwritten'));
      continue;
    end if;

    v_old := jsonb_build_object('audited_at', e.audited_at, 'autofail', e.autofail, 'score', e.original_score, 'fcr', e.fcr, 'feedback', e.feedback, 'scores', v_old_scores);
    perform set_config('app.allow_sheet_resync', 'on', true);
    update public.evaluations set autofail = v_af, original_score = v_score, fcr = v_fcr, feedback = v_fb, audited_at = v_at where id = e.id;
    for s in select * from jsonb_array_elements(coalesce(r -> 'scores', '[]'::jsonb)) loop
      insert into public.evaluation_scores (evaluation_id, parameter_id, earned, max_score)
      select e.id, p.id, nullif(s ->> 'earned', '')::numeric, p.max_score
        from public.evaluation_parameters p where p.id = (s ->> 'parameter_id')::uuid
      on conflict (evaluation_id, parameter_id) do update set earned = excluded.earned;
    end loop;
    perform set_config('app.allow_sheet_resync', 'off', true);
    insert into public.audit_logs (actor_id, action, table_name, record_id, previous, new_value)
    values (null, 'sheet_resync', 'evaluations', e.id::text, v_old,
            jsonb_build_object('audited_at', v_at, 'autofail', v_af, 'score', v_score, 'fcr', v_fcr, 'feedback', v_fb, 'scores', v_new_scores, 'sheet_row', r ->> 'row_number'));
    n_upd := n_upd + 1;
  end loop;
  return jsonb_build_object('updated', n_upd, 'unchanged', n_same, 'conflicts', conflicts);
end $$;
revoke execute on function public.resync_evaluations(jsonb) from public, anon, authenticated;
grant execute on function public.resync_evaluations(jsonb) to service_role;
