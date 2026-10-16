-- =============================================================================
-- Weekly scorecard uses the "Team List" tab of the audit sheet (CAMs from row 11
-- down) as the list of members: only their audits are counted, and members with
-- no audits form the exclusion list. The sheet script sends the list; it is kept
-- in settings.scorecard.members. Safe to run more than once.
-- =============================================================================
create or replace function public.set_scorecard_members(p_emails text[])
returns int language plpgsql security definer set search_path = public as $$
declare v text[];
begin
  select coalesce(array_agg(distinct lower(trim(x))), '{}') into v
    from unnest(coalesce(p_emails, '{}')) x where trim(x) ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$';
  if array_length(v, 1) is null then return 0; end if;   -- never wipe the list with an empty read
  update public.settings
     set value = value || jsonb_build_object('members', to_jsonb(v), 'members_synced_at', now())
   where key = 'scorecard';
  return array_length(v, 1);
end $$;
revoke execute on function public.set_scorecard_members(text[]) from public, anon, authenticated;
grant execute on function public.set_scorecard_members(text[]) to service_role;
