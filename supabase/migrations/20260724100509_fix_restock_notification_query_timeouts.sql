-- AdminRestockNotification.tsx polls two queries against repricer_price_actions
-- (2.45M rows and growing) every 30 seconds per open admin session. Both were
-- timing out with 500s in production, confirmed via EXPLAIN ANALYZE:
--   - The reason ILIKE OR query: 2.2s, scanning 240k+ rows via the created_at
--     index with the ILIKE applied as a row-by-row filter (no matches found —
--     ILIKE with a leading wildcard can't use a plain btree index).
--   - The intelligence_factors jsonb containment query: 99+ SECONDS. There's
--     already a GIN index on this column (idx_rpa_intelligence_factors_gin),
--     but the planner ignores it for this predicate shape in favor of the
--     created_at index + row-by-row filter over 480k+ rows — and forcing
--     bitmap-index-only scans still timed out, meaning the existing GIN index
--     itself isn't fast enough for this query at the current table size.
--
-- Both queries confirmed ZERO actual matches in the last 7 days of data, so a
-- partial index scoped to exactly these predicates will be tiny (near-empty)
-- and stay fast regardless of how large the base table grows — unlike a
-- full-column index, which must account for every row.
--
-- CONCURRENTLY avoids locking the table (which is under continuous write load
-- from live repricing) during index creation.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rpa_restock_ilike_partial
ON public.repricer_price_actions (created_at DESC)
WHERE (reason ILIKE '%restock%' OR reason ILIKE '%snap-back%' OR reason ILIKE '%snap_back%');

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rpa_restock_reentry_partial
ON public.repricer_price_actions (created_at DESC)
WHERE (intelligence_factors @> '{"guardsApplied":["restock_reentry_detected"]}'::jsonb);
