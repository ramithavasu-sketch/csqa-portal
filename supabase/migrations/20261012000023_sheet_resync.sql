-- =============================================================================
-- Edits made in the audit sheet after a task was imported (e.g. QA changes a task
-- to Auto-Fail = Yes, Score 0) now reach the portal. The sheet script re-sends
-- recent rows; resync_evaluations() compares each with the stored original and,
-- when it differs, updates the original audit — but only when the task has no
-- submitted appeal and no score adjustment (those are never overwritten; they are
-- reported back as conflicts). Every change is written to the audit log.
-- Safe to run more than once.
-- =============================================================================
create or replace function public.block_evaluation_changes()
returns trigger language plpgsql as $$
begin
  if current_setting('app.allow_evaluation_purge', true) = 'on' and tg_op = 'DELETE' then
    return old;
  end if;
  -- merge_employee() may re-point an archived audit to the right CAM
  if tg_op = 'UPDATE' and tg_table_name = 'evaluations' and current_setting('app.allow_cam_merge', true) = 'on'
     and (to_jsonb(new) - 'cam_id') = (to_jsonb(old) - 'cam_id') then
    return new;
  end if;
  -- resync_evaluations() may correct an original from the audit sheet (no appeal / adjustment on it)
  if tg_op in ('UPDATE', 'INSERT') and tg_table_name in ('evaluations', 'evaluation_scores')
     and current_setting('app.allow_sheet_resync', true) = 'on' then
    return new;
  end if;
  raise exception 'Original evaluation records are immutable. Use a score adjustment instead.';
end $$;

-- p_rows: mapper ImportRow objects (same as import_evaluations). Service role only.
create or replace function public.resync_evaluations(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r jsonb; s jsonb; e public.evaluations; v_cam uuid; v_period uuid;
  v_af boolean; v_score numeric; v_fcr text; v_fb text;
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
    select coalesce(jsonb_object_agg(x ->> 'parameter_id', nullif(x ->> 'earned', '')::numeric), '{}'::jsonb) into v_new_scores
      from jsonb_array_elements(coalesce(r -> 'scores', '[]'::jsonb)) x;
    select coalesce(jsonb_object_agg(parameter_id::text, earned), '{}'::jsonb) into v_old_scores
      from public.evaluation_scores where evaluation_id = e.id;

    if e.autofail = v_af and e.original_score = v_score and e.fcr is not distinct from v_fcr
       and e.feedback is not distinct from v_fb and v_old_scores @> v_new_scores and v_new_scores @> v_old_scores then
      n_same := n_same + 1; continue;
    end if;

    if exists (select 1 from public.appeals a where a.evaluation_id = e.id and a.status <> 'draft')
       or exists (select 1 from public.score_adjustments sa where sa.evaluation_id = e.id) then
      conflicts := conflicts || jsonb_build_array(jsonb_build_object('row', r ->> 'row_number', 'task_link', e.task_link, 'cam', r ->> 'cam_email',
        'reason', 'changed in the sheet but this task has an appeal or a QA score correction — not overwritten'));
      continue;
    end if;

    v_old := jsonb_build_object('autofail', e.autofail, 'score', e.original_score, 'fcr', e.fcr, 'feedback', e.feedback, 'scores', v_old_scores);
    perform set_config('app.allow_sheet_resync', 'on', true);
    update public.evaluations set autofail = v_af, original_score = v_score, fcr = v_fcr, feedback = v_fb where id = e.id;
    for s in select * from jsonb_array_elements(coalesce(r -> 'scores', '[]'::jsonb)) loop
      insert into public.evaluation_scores (evaluation_id, parameter_id, earned, max_score)
      select e.id, p.id, nullif(s ->> 'earned', '')::numeric, p.max_score
        from public.evaluation_parameters p where p.id = (s ->> 'parameter_id')::uuid
      on conflict (evaluation_id, parameter_id) do update set earned = excluded.earned;
    end loop;
    perform set_config('app.allow_sheet_resync', 'off', true);
    insert into public.audit_logs (actor_id, action, table_name, record_id, previous, new_value)
    values (null, 'sheet_resync', 'evaluations', e.id::text, v_old,
            jsonb_build_object('autofail', v_af, 'score', v_score, 'fcr', v_fcr, 'feedback', v_fb, 'scores', v_new_scores, 'sheet_row', r ->> 'row_number'));
    n_upd := n_upd + 1;
  end loop;
  return jsonb_build_object('updated', n_upd, 'unchanged', n_same, 'conflicts', conflicts);
end $$;
revoke execute on function public.resync_evaluations(jsonb) from public, anon, authenticated;
grant execute on function public.resync_evaluations(jsonb) to service_role;
