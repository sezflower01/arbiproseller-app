-- Attempt tracking for automatic order-placement gap repair.
--
-- THE PROBLEM THIS SOLVES, AND THE ONE IT MUST NOT CREATE
-- ------------------------------------------------------
-- `check_sync_parity` already finds days where Financial Events has shipments
-- but sales_orders has no placement row (`gap_type = 'so_missing'`). The
-- Profit & Loss banner surfaces those and offers a manual Orders API backfill,
-- with the text "Nothing repairs these gaps automatically -- run this when you
-- see one." This table is what lets that become automatic.
--
-- ⚠️ The reason it was left manual is the important part. SOME GAPS ARE
-- PERMANENT: if Amazon's Orders API never returned the placement rows for a
-- day, no amount of re-asking will produce them. A human sees a repair fail
-- twice and stops clicking. A nightly job does not -- it would re-attempt the
-- same dead days every night forever, spending SP-API quota on a repair that
-- cannot succeed.
--
-- That is the same shape as the ghost-row retry loop found 2026-08-21, which
-- re-attempted an impossible insert every 2.7 seconds for weeks. The attempt
-- counter below is the whole reason this automation is safe to run at all.
--
-- STATUS MEANINGS
--   pending    -- gap seen, under the attempt cap, will be retried
--   repaired   -- a backfill ran and the parity check came back clean
--   permanent  -- cap reached; the day is genuinely missing from Amazon's side
--
-- `permanent` is NOT a synonym for "hide it". The banner continues to show
-- these days, reworded from "click to repair" to "confirmed unrepairable", and
-- keeps a manual override -- Amazon does occasionally backfill its own history
-- later. Automation that quietly buried the fact that data is missing would be
-- the exact failure this codebase keeps getting bitten by.

CREATE TABLE IF NOT EXISTS public.order_gap_repair_attempts (
  user_id            uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  check_date         date        NOT NULL,
  marketplace        text        NOT NULL DEFAULT 'US',
  attempts           int         NOT NULL DEFAULT 0,
  status             text        NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'repaired', 'permanent')),
  first_seen_at      timestamptz NOT NULL DEFAULT now(),
  last_attempted_at  timestamptz,
  last_result        text,
  -- Counts from the parity check at the last attempt, so a human can see how
  -- big the gap was without re-deriving it.
  so_count           bigint,
  fec_count          bigint,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, check_date, marketplace)
);

-- The worker's hot path: "which gaps may I still try for this user".
CREATE INDEX IF NOT EXISTS idx_ogra_user_status
  ON public.order_gap_repair_attempts (user_id, status, check_date);

ALTER TABLE public.order_gap_repair_attempts ENABLE ROW LEVEL SECURITY;

-- Read-only to the owner: the banner needs to show which days are permanent.
-- Writes are service_role only -- the worker owns the attempt count, and a
-- client resetting it would defeat the cap that makes this safe.
DROP POLICY IF EXISTS "Users read their own gap repair attempts"
  ON public.order_gap_repair_attempts;
CREATE POLICY "Users read their own gap repair attempts"
  ON public.order_gap_repair_attempts FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

GRANT SELECT ON public.order_gap_repair_attempts TO authenticated;
GRANT ALL    ON public.order_gap_repair_attempts TO service_role;

-- Self-verifying: RLS on, exactly one policy, and it is SELECT-only.
DO $$
DECLARE
  v_rls boolean;
  v_policies int;
  v_writes int;
BEGIN
  SELECT c.relrowsecurity INTO v_rls
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'order_gap_repair_attempts';

  IF v_rls IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'RLS not enabled on order_gap_repair_attempts';
  END IF;

  SELECT count(*) INTO v_policies
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'order_gap_repair_attempts';

  SELECT count(*) INTO v_writes
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'order_gap_repair_attempts'
    AND cmd <> 'SELECT';

  IF v_policies <> 1 OR v_writes <> 0 THEN
    RAISE EXCEPTION
      'Expected exactly 1 SELECT-only policy, found % policies (% non-SELECT)',
      v_policies, v_writes;
  END IF;

  RAISE NOTICE 'order_gap_repair_attempts: RLS enabled, 1 SELECT-only policy';
END $$;
