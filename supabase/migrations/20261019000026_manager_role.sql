-- New role: Team Manager (sees every team's published results, read-only). Own file: a new
-- enum value must be committed before it is used. Safe to run more than once.
alter type public.app_role add value if not exists 'manager';
