-- =============================================================================
-- GUARD TEST: temporarily delete service_fee rows for a recent month to verify
-- isMonthCached() correctly flips it to 'partial' (within 60-day guard window).
--
-- SAFETY MODEL:
--   1. Runs entirely inside a single transaction — nothing is committed until
--      you explicitly `COMMIT;` at the bottom.
--   2. Before deleting, we snapshot the exact rows into a real (not temp) table
--      `_guard_test_backup_service_fees` so a revert works even after the
--      session ends or edge functions run against the DB in between.
--   3. Revert is a plain INSERT ... SELECT from the backup table.
--   4. Restricted to ONE user + ONE month + event_type='service_fee' only.
--
-- USAGE:
--   Step 1: set :user_id and :month_start below, then run STEP 1 (BEGIN..SELECT).
--           Verify the "would delete" count looks right. If wrong, ROLLBACK.
--   Step 2: run STEP 2 (the DELETE + COMMIT). Now click View in the UI for
--           that month — it should show 'partial' and trigger a re-sync.
--   Step 3: run STEP 3 (revert) to restore the deleted rows.
--   Step 4: run STEP 4 to drop the backup table once you've confirmed revert.
-- =============================================================================

-- ---------------- CONFIGURE ----------------
-- Set these two values before running:
--   :user_id      the user whose data you want to test against (use your own)
--   :month_start  first day of a RECENT month (within 60 days), e.g. '2026-06-01'
-- -------------------------------------------

-- ============ STEP 1: dry-run count (safe, no writes) ============
BEGIN;

-- Show what we'd delete, and how old the month is
WITH cfg AS (
  SELECT
    :'user_id'::uuid                                   AS user_id,
    :'month_start'::date                               AS month_start,
    (date_trunc('month', :'month_start'::date) + interval '1 month - 1 day')::date AS month_end
)
SELECT
  cfg.month_start,
  cfg.month_end,
  (CURRENT_DATE - cfg.month_end)                       AS days_since_month_end,
  (CURRENT_DATE - cfg.month_end) <= 60                 AS within_guard_window,
  COUNT(*) FILTER (WHERE fec.event_type = 'service_fee') AS service_fee_rows_to_delete,
  COUNT(*) FILTER (WHERE fec.event_type = 'shipment')    AS shipment_rows_kept,
  COUNT(*)                                             AS total_rows_in_month
FROM cfg
LEFT JOIN financial_events_cache fec
  ON fec.user_id = cfg.user_id
 AND fec.event_date >= cfg.month_start
 AND fec.event_date <= cfg.month_end
GROUP BY cfg.month_start, cfg.month_end;

-- If the numbers look wrong, run:
--   ROLLBACK;
-- and re-check :user_id / :month_start. Otherwise proceed to STEP 2.

COMMIT;


-- ============ STEP 2: snapshot + delete (transactional) ============
BEGIN;

-- Create the backup table if it doesn't already exist
CREATE TABLE IF NOT EXISTS _guard_test_backup_service_fees (LIKE financial_events_cache INCLUDING ALL);

-- Snapshot the exact rows we're about to remove
INSERT INTO _guard_test_backup_service_fees
SELECT fec.*
FROM financial_events_cache fec
WHERE fec.user_id    = :'user_id'::uuid
  AND fec.event_type = 'service_fee'
  AND fec.event_date >= :'month_start'::date
  AND fec.event_date <= (date_trunc('month', :'month_start'::date) + interval '1 month - 1 day')::date;

-- Confirm snapshot count matches what we're deleting
SELECT
  (SELECT COUNT(*) FROM _guard_test_backup_service_fees
     WHERE user_id = :'user_id'::uuid
       AND event_date >= :'month_start'::date
       AND event_date <= (date_trunc('month', :'month_start'::date) + interval '1 month - 1 day')::date
  ) AS snapshotted_rows,
  (SELECT COUNT(*) FROM financial_events_cache
     WHERE user_id    = :'user_id'::uuid
       AND event_type = 'service_fee'
       AND event_date >= :'month_start'::date
       AND event_date <= (date_trunc('month', :'month_start'::date) + interval '1 month - 1 day')::date
  ) AS live_rows_to_delete;

-- Delete
DELETE FROM financial_events_cache
WHERE user_id    = :'user_id'::uuid
  AND event_type = 'service_fee'
  AND event_date >= :'month_start'::date
  AND event_date <= (date_trunc('month', :'month_start'::date) + interval '1 month - 1 day')::date;

-- Final verification: month should now have 0 service_fee rows
SELECT
  event_type,
  COUNT(*) AS row_count
FROM financial_events_cache
WHERE user_id = :'user_id'::uuid
  AND event_date >= :'month_start'::date
  AND event_date <= (date_trunc('month', :'month_start'::date) + interval '1 month - 1 day')::date
GROUP BY event_type
ORDER BY event_type;

-- If everything looks right (0 service_fee rows, shipments still present):
COMMIT;
-- If not:
-- ROLLBACK;
-- The DELETE will be undone AND the backup insert will be undone together.


-- ============ NOW: click "View" for that month in the UI ============
-- Expected:
--   * RPC returns status='partial' for this month (shipment_cnt>0, service_fee_cnt=0)
--   * (CURRENT_DATE - month_end) <= 60, so guard does NOT flip it to 'cached'
--   * Frontend fires forceRefresh=true → edge function re-fetches service fees
-- Grep edge logs for:
--   [isMonthCached] <label> total=<N> ship=<N> sf=0 ageDays=<N> old=false → PARTIAL


-- ============ STEP 3: revert (restore deleted rows) ============
BEGIN;

INSERT INTO financial_events_cache
SELECT *
FROM _guard_test_backup_service_fees
WHERE user_id    = :'user_id'::uuid
  AND event_date >= :'month_start'::date
  AND event_date <= (date_trunc('month', :'month_start'::date) + interval '1 month - 1 day')::date
ON CONFLICT DO NOTHING;  -- in case a live sync already re-fetched some of them

-- Verify
SELECT
  event_type,
  COUNT(*) AS row_count
FROM financial_events_cache
WHERE user_id = :'user_id'::uuid
  AND event_date >= :'month_start'::date
  AND event_date <= (date_trunc('month', :'month_start'::date) + interval '1 month - 1 day')::date
GROUP BY event_type
ORDER BY event_type;

COMMIT;


-- ============ STEP 4: cleanup backup table (only after confirming revert) ============
-- DROP TABLE _guard_test_backup_service_fees;
