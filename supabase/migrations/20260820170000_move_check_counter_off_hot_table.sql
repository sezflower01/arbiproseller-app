-- Move the daily check counter off repricer_assignments.
--
-- WHY. repricer_assignments is in the supabase_realtime publication, so EVERY
-- update to it is decoded, RLS-filtered and broadcast to subscribers -- and
-- realtime broadcasts on any row change, regardless of which column moved.
--
-- Measured 2026-08-20 over a 51.28h pg_stat_statements window:
--   repricer_assignments UPDATE calls   1,704,493   (~9.2/second)
--   realtime.list_changes calls           717,900
--   realtime buffer volume             32,481 GB
--   realtime exec time                 31,370 s    (8.7 hours of CPU)
-- realtime.list_changes alone was 93% of the top-15 queries by data volume,
-- 14x the next entry.
--
-- checks_today_count is 295,964 of those updates (17.4%) and is PURE TELEMETRY:
-- repricer-scheduler's own comment says "Increment for monitoring, but do NOT
-- block on any cap". Nothing in src/ reads it, and the only edge-function
-- references are the scheduler reading its own previous value in order to
-- increment it again. It was writing to the hottest table in the database, at
-- 1.6 writes/second, so that it could be incremented next cycle.
--
-- KEPT, NOT DELETED, at the user's request: the signal stays available for
-- ad-hoc "is the repricer still evaluating this ASIN" checks even though no
-- code consumes it.
--
-- The old columns on repricer_assignments are deliberately NOT dropped here.
-- Dropping is destructive and irreversible; this migration only stops the
-- writes. Retire them separately once the new table is confirmed populating.
--
-- Verified before writing: pg_publication.puballtables = false for both
-- publications, so this new table is NOT auto-published and its writes generate
-- no realtime traffic. That assumption is asserted at the end -- if a future
-- change makes the publication FOR ALL TABLES, this migration's whole purpose
-- silently evaporates, and silent evaporation is what this work exists to stop.

CREATE TABLE IF NOT EXISTS public.repricer_assignment_check_counters (
  assignment_id      uuid PRIMARY KEY
                       REFERENCES public.repricer_assignments(id) ON DELETE CASCADE,
  user_id            uuid NOT NULL,
  checks_today_count integer NOT NULL DEFAULT 0,
  checks_today_date  date    NOT NULL,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_assignment_check_counters_user
  ON public.repricer_assignment_check_counters (user_id, checks_today_date);

ALTER TABLE public.repricer_assignment_check_counters ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "check_counters own" ON public.repricer_assignment_check_counters;
CREATE POLICY "check_counters own" ON public.repricer_assignment_check_counters
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "check_counters service" ON public.repricer_assignment_check_counters;
CREATE POLICY "check_counters service" ON public.repricer_assignment_check_counters
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Carry the current values across so the signal is continuous rather than
-- restarting from zero.
--
-- repricer_assignments.checks_today_date is TEXT, not date -- the first attempt
-- at this migration failed on exactly that (42804), which is why the cast is
-- explicit. The regex guard is not decoration: all 2,606 rows were well-formed
-- when checked, but an unparseable value would abort the whole migration, and a
-- telemetry backfill should never be able to do that.
INSERT INTO public.repricer_assignment_check_counters
  (assignment_id, user_id, checks_today_count, checks_today_date)
SELECT a.id, a.user_id, COALESCE(a.checks_today_count, 0), a.checks_today_date::date
FROM public.repricer_assignments a
WHERE a.checks_today_date IS NOT NULL
  AND a.checks_today_date ~ '^\d{4}-\d{2}-\d{2}$'
ON CONFLICT (assignment_id) DO NOTHING;

-- One statement, no read-then-write.
--
-- The old code SELECTed checks_today_count/checks_today_date with the
-- assignment, compared the date in TypeScript, then wrote back. Doing the
-- day-rollover comparison here means the scheduler needs neither column, so
-- they come out of its SELECT list as well as its UPDATE.
CREATE OR REPLACE FUNCTION public.bump_assignment_check_counter(p_assignment_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user uuid;
  v_today date := (now() AT TIME ZONE 'UTC')::date;
BEGIN
  SELECT a.user_id INTO v_user FROM public.repricer_assignments a WHERE a.id = p_assignment_id;
  IF v_user IS NULL THEN
    RETURN;  -- assignment gone; a telemetry counter must never fail a caller
  END IF;

  INSERT INTO public.repricer_assignment_check_counters
    (assignment_id, user_id, checks_today_count, checks_today_date, updated_at)
  VALUES (p_assignment_id, v_user, 1, v_today, now())
  ON CONFLICT (assignment_id) DO UPDATE
    SET checks_today_count = CASE
          WHEN public.repricer_assignment_check_counters.checks_today_date = v_today
          THEN public.repricer_assignment_check_counters.checks_today_count + 1
          ELSE 1
        END,
        checks_today_date = v_today,
        updated_at = now();
END;
$$;

REVOKE ALL ON FUNCTION public.bump_assignment_check_counter(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.bump_assignment_check_counter(uuid) TO service_role;

DO $$
DECLARE
  n int;
BEGIN
  SELECT count(*) INTO n
  FROM pg_publication_tables
  WHERE tablename = 'repricer_assignment_check_counters';
  IF n <> 0 THEN
    RAISE EXCEPTION 'repricer_assignment_check_counters is published to realtime — the whole point of this migration is that it is not';
  END IF;

  SELECT count(*) INTO n FROM public.repricer_assignment_check_counters;
  RAISE NOTICE 'check-counter side table ready, not published, backfilled % row(s)', n;
END $$;
