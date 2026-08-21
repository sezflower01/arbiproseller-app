-- Enable RLS on full_inventory_refresh_runs.
--
-- Flagged CRITICAL by the Supabase security advisor: the table was created on
-- 2026-07-31 (20260731040000) with a CREATE TABLE, an index and a service_role
-- grant, but no ENABLE ROW LEVEL SECURITY. Supabase's default privileges hand
-- anon/authenticated access to public-schema tables, so PostgREST exposed it to
-- every logged-in user.
--
-- Why that matters here rather than being a formality:
--   * `user_ids jsonb NOT NULL` holds every user id a run covers, so a read
--     leaks the platform's user roster. This project has more than one login.
--   * `user_cursor` / `item_cursor` are live progress state for a fleet-wide
--     refresh. A write could rewind or skip work, or mark a running job
--     'completed' and let the timeout sweep ignore a job that had actually died.
--
-- NO POLICIES ARE CREATED, deliberately. Everything that touches this table is
-- an edge function running as service_role, which bypasses RLS -- verified:
-- full-inv-refresh-timeout-sweep and the refresh worker are the only readers,
-- and nothing in src/ queries it (its appearance in types.ts is generated
-- output, not a call site). RLS with zero policies is therefore the exact
-- intent: service_role only, deny everyone else, no policy to get subtly wrong
-- later.
--
-- The REVOKE is belt-and-braces. RLS alone is sufficient, but removing the
-- implicit grants states the intent in the schema and keeps the table shut if
-- someone later adds a permissive policy without thinking about it.
--
-- Checked at the same time: this is the ONLY table across all migrations that
-- was missing RLS. An isolated omission, not a pattern.

ALTER TABLE public.full_inventory_refresh_runs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.full_inventory_refresh_runs FROM anon, authenticated;

-- Self-verifying: fail the migration rather than report success on a no-op.
DO $$
DECLARE
  v_rls boolean;
  v_policies int;
BEGIN
  SELECT c.relrowsecurity INTO v_rls
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'full_inventory_refresh_runs';

  IF v_rls IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'RLS not enabled on public.full_inventory_refresh_runs';
  END IF;

  SELECT count(*) INTO v_policies
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'full_inventory_refresh_runs';

  IF v_policies <> 0 THEN
    RAISE EXCEPTION
      'Expected zero policies on full_inventory_refresh_runs, found % -- service_role bypasses RLS and needs none',
      v_policies;
  END IF;

  RAISE NOTICE 'full_inventory_refresh_runs: RLS enabled, % policies (service_role only)', v_policies;
END $$;
