-- Portal feedback tracker (0034), sheet clean-up of moved weeks (0033), Setmore two-way sync (0029–0032).
-- Runs after 10–60, reusing their fixtures.
set client_min_messages = notice;
reset session authorization;

-- ---------------------------------------------------------------- feedback tracker
select public.test_as('cam.a1@test.co'); set session authorization authenticated;
select public.submit_portal_feedback('bug', 'The download button shows an error.', '/reports', 4);
select public.expect_error($$ select public.set_portal_feedback_status((select id from public.portal_feedback limit 1), 'fixed') $$, '%Only a Super Admin%', 'a CAM cannot change a feedback stage');
reset session authorization;
insert into public.test_ids select 'fb1', id from public.portal_feedback where message = 'The download button shows an error.';

select public.test_as('qa@test.co'); set session authorization authenticated;
select public.set_portal_feedback_status(public.tid('fb1'), 'planned', 'Planned for next week');
select public.assert_true((select status = 'planned' and admin_note = 'Planned for next week' and resolved_at is null and status_changed_at is not null
  from public.list_portal_feedback() where id = public.tid('fb1')), 'Super Admin moves feedback into the pipeline with a note');
select public.set_portal_feedback_status(public.tid('fb1'), 'fixed');
select public.assert_true((select status = 'fixed' and resolved_at is not null and admin_note = 'Planned for next week' from public.list_portal_feedback() where id = public.tid('fb1')),
  'marking it fixed records the date and keeps the note');
select public.set_portal_feedback_status(public.tid('fb1'), 'in_progress', '');
select public.assert_true((select status = 'in_progress' and resolved_at is null and admin_note is null from public.list_portal_feedback() where id = public.tid('fb1')),
  'reopening clears the fixed date; an empty note clears the note');
select public.expect_error($$ select public.set_portal_feedback_status(public.tid('fb1'), 'done') $$, '%Unknown status%', 'unknown stages are refused');
select public.set_portal_feedback_status(public.tid('fb1'), 'fixed', 'Fixed in the latest release');
reset session authorization;
select public.test_as('cam.a1@test.co'); set session authorization authenticated;
select public.assert_true((select count(*) = 1 and bool_and(status = 'fixed' and admin_note = 'Fixed in the latest release') from public.my_portal_feedback()), 'the sender sees the stage and QA note');
select public.assert_true((select count(*) = 0 from public.list_portal_feedback()), 'a CAM cannot list everyone''s feedback');
reset session authorization;
select public.test_as('cam.a2@test.co'); set session authorization authenticated;
select public.assert_true((select count(*) = 0 from public.my_portal_feedback()), 'other people do not see someone else''s feedback');
reset session authorization;

-- ---------------------------------------------------------------- sheet clean-up: a row moved to another week
insert into public.reporting_periods (label, short_label, year, week_number, start_date, end_date) values
  ('RC-A : 2027', 'RC-A', 2027, 5, '2027-02-04', '2027-02-10'),
  ('RC-B : 2027', 'RC-B', 2027, 6, '2027-02-08', '2027-02-14'),
  ('RC-C : 2027', 'RC-C', 2027, 7, '2027-02-11', '2027-02-17');
insert into public.evaluations (task_id, task_link, cam_id, task_type, audited_at, period_id, autofail, original_score)
select v.t, 'https://ds.test/crm#task/' || v.t, public.tid('cam_a1'), 'INTERNAL', now(), p.id, false, 100
from (values ('rc-1', 'RC-A : 2027'), ('rc-1', 'RC-B : 2027'), ('rc-2', 'RC-B : 2027'), ('rc-3', 'RC-A : 2027'), ('rc-3', 'RC-C : 2027')) v(t, w)
join public.reporting_periods p on p.label = v.w;
-- the sheet now has rc-1 and rc-3 under RC-A only; RC-C has a stray row without a task link, so it is in the week list but has no keys
select public.reconcile_evaluations(array['RC-A : 2027', 'RC-C : 2027'],
  jsonb_build_array(jsonb_build_array('https://ds.test/crm#task/rc-1', 'cam.a1@test.co', 'RC-A : 2027'), jsonb_build_array('https://ds.test/crm#task/rc-3', 'cam.a1@test.co', 'RC-A : 2027')));
select public.assert_true((select count(*) = 2 from public.evaluations e join public.reporting_periods p on p.id = e.period_id where p.label = 'RC-A : 2027'), 'clean-up keeps the rows that are in the sheet');
select public.assert_true(not exists (select 1 from public.evaluations e join public.reporting_periods p on p.id = e.period_id where p.label = 'RC-B : 2027' and e.task_id = 'rc-1'),
  'a copy left in a week the sheet no longer uses is removed when the task is under another week');
select public.assert_true(exists (select 1 from public.evaluations e join public.reporting_periods p on p.id = e.period_id where p.label = 'RC-B : 2027' and e.task_id = 'rc-2'),
  'an audit not found anywhere in the sheet is left alone');
select public.assert_true(exists (select 1 from public.reporting_periods where label = 'RC-B : 2027'), 'a week that still has audits is kept');
select public.assert_true(not exists (select 1 from public.reporting_periods where label = 'RC-C : 2027'), 'a week whose only sheet rows have no task link is removed once its copies are gone');
select public.assert_true(exists (select 1 from public.audit_logs where action = 'sheet_reconcile_week_removed' and previous ->> 'label' = 'RC-C : 2027'), 'the removed week is kept in the audit log');

-- ---------------------------------------------------------------- Setmore: changes in the portal are sent to Setmore
insert into public.settings (key, value) values ('setmore', '{"connected": true}') on conflict (key) do update set value = excluded.value;
insert into public.app_secrets (key, value) values ('setmore_cron', 'test-secret-test-secret-test') on conflict (key) do update set value = excluded.value;
insert into public.feedback_cycles (number, period_ids, released_at) values (90, array[public.tid('period')], now() - interval '2 days');
insert into public.feedback_sessions (cycle_id, cam_id, provider_id, provider_name, status)
select id, public.tid('cam_a1'), public.tid('qa'), 'QA One', 'not_booked' from public.feedback_cycles where number = 90;
insert into public.test_ids select 'fs1', s.id from public.feedback_sessions s join public.feedback_cycles c on c.id = s.cycle_id where c.number = 90;
truncate net.calls;
select public.test_as('cam.a1@test.co'); set session authorization authenticated;
select public.mark_feedback_booked(public.tid('fs1'), '2027-03-01 15:00+05:30');
reset session authorization;
select public.assert_true((select count(*) = 1 and bool_and(body ->> 'action' = 'push_booking' and body ->> 'session' = public.tid('fs1')::text) from net.calls),
  'a time entered in the portal is booked in Setmore');
update public.feedback_sessions set setmore_key = '11111111-2222-4333-8444-555555555555' where id = public.tid('fs1');
select public.test_as('cam.a1@test.co'); set session authorization authenticated;
select public.clear_feedback_booking(public.tid('fs1'));
reset session authorization;
select public.assert_true(exists (select 1 from net.calls where body ->> 'action' = 'set_label' and body ->> 'label' = 'Cancelled'), 'cancelling in the portal labels the Setmore appointment Cancelled');
update public.feedback_sessions set status = 'booked' where id = public.tid('fs1');
select public.test_as('qa@test.co'); set session authorization authenticated;
select public.update_feedback_session(public.tid('fs1'), null, 'completed');
reset session authorization;
select public.assert_true(exists (select 1 from net.calls where body ->> 'action' = 'set_label' and body ->> 'label' = 'Complete'), 'completing in the portal labels the Setmore appointment Complete');

-- Setmore -> portal: a "Complete" label completes the session; a "Cancelled" label cancels it; nothing is sent back
update public.feedback_sessions set status = 'booked', completed_at = null, booked_for = '2027-03-01 15:00+05:30', booking_source = 'setmore' where id = public.tid('fs1');
truncate net.calls;
select public.apply_setmore_appointments(jsonb_build_array(jsonb_build_object('key', '11111111-2222-4333-8444-555555555555', 'start', '2027-03-01T15:00:00+05:30',
  'staff_email', 'qa@test.co', 'customer_email', 'cam.a1@test.co', 'label', 'Complete')), now() - interval '30 days');
select public.assert_true((select status = 'completed' from public.feedback_sessions where id = public.tid('fs1')), 'labelled Complete in Setmore -> Completed in the portal');
update public.feedback_sessions set status = 'booked', completed_at = null where id = public.tid('fs1');
select public.apply_setmore_appointments(jsonb_build_array(jsonb_build_object('key', '11111111-2222-4333-8444-555555555555', 'start', '2027-03-01T15:00:00+05:30',
  'staff_email', 'qa@test.co', 'customer_email', 'cam.a1@test.co', 'label', 'Cancelled')), now() - interval '30 days');
select public.assert_true((select status = 'cancelled' from public.feedback_sessions where id = public.tid('fs1')), 'labelled Cancelled in Setmore -> Cancelled in the portal');
select public.assert_true((select count(*) = 0 from net.calls), 'changes that came from Setmore are not sent back to Setmore');
update public.settings set value = '{"connected": false}' where key = 'setmore';
