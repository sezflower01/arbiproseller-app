-- Index for self-heal-pending-prices -> repairUser(), which runs hourly and
-- was appearing in the logs as "canceling statement due to statement timeout".
--
-- ⚠️ THE TIMEOUTS WERE NOT THIS QUERY'S FAULT. Measured warm it ran in 66.8ms.
-- It shows up in the timeout log as a VICTIM of the connection contention
-- tracked separately (item 8), not as the cause -- the same way
-- capture_system_load and net.http_post appear there at ~45-64s with nothing
-- slow inside them. This index is a genuine efficiency fix that removes one
-- contributor to that pressure. It is NOT the fix for the timeouts, and if the
-- hourly timeout lines continue, that is expected and not a regression here.
--
-- WHY THIS SHAPE, AFTER TWO WRONG ONES
-- ------------------------------------
-- The query filters on four things and sorts by two:
--
--   user_id = $1
--   order_status IN ('Pending','Unknown','')
--   marketplace  IN ('US','ATVPDKIKX0DER')
--   (sold_price IS NULL OR sold_price = 0)
--   (price_source LIKE 'estimated:%' OR price_source IS NULL)
--   ORDER BY purchase_timestamp_utc DESC NULLS LAST, order_date DESC
--
-- Attempt 1 was a plain composite:
--   (user_id, order_status, marketplace, purchase_timestamp_utc DESC NULLS LAST, order_date DESC)
-- The planner refused it, correctly. sold_price and price_source were not in
-- the index, so every candidate row still had to be fetched from the heap to
-- evaluate them -- 6,230 of the query's 6,236 buffers. The index reordered work
-- that was already cheap and skipped the work that was expensive. Dropped.
--
-- The selectivity is the whole story: 610 rows match out of 70,172 for this
-- user (0.87%), and it is sold_price/price_source that makes it 610. Anything
-- that does not encode those two conditions cannot help.
--
-- Attempt 2 put order_status IN (...) inside the partial predicate. Not
-- measured -- it never got created, because it was run in a multi-statement
-- block whose later PREPARE failed, and the Supabase SQL Editor wraps a block
-- in one transaction, so the CREATE rolled back with it. Worth knowing: an
-- EXPLAIN after that block looked like the index had been rejected, when in
-- fact it had never existed. The identical cost estimate (6692.34..6692.46,
-- byte for byte) was the tell.
--
-- This version keeps order_status as an indexed COLUMN and leaves only simple
-- OR conditions in the predicate. Postgres's predicate-implication prover
-- handles those reliably; it is far weaker on = ANY(array) implications, which
-- is what an IN-list in a predicate compiles to.
--
-- MEASURED 2026-08-22, same query, same user, before and after:
--   execution   66.8ms warm / 752ms cold  ->  0.153ms
--   buffers     6,236                     ->  19
--   filtered    19,792 rows discarded     ->  5
--   cost        6692.34                   ->  42.75
--
-- The Sort node survives, deliberately unfixed. order_status = ANY(...) is a
-- ScalarArrayOp on the second column, so the index cannot guarantee ordering
-- for the trailing sort keys. It sorts 10 rows in 25kB. Restructuring the
-- index to eliminate it would cost more than the sort does.
--
-- ONE OPEN RISK, worth checking before assuming this holds forever: the plan
-- above was proven with literal values. The real caller is PostgREST, which
-- parameterises, and a GENERIC plan cannot prove a partial-index predicate
-- against unknown parameters. Postgres only adopts a generic plan when it is
-- not materially worse than the custom plans, and here it is far worse, so it
-- should keep replanning. The authoritative check is not a prepared-statement
-- experiment but pg_stat_user_indexes.idx_scan on this index after a real
-- hourly cycle -- if the live caller is using it, idx_scan climbs.

CREATE INDEX IF NOT EXISTS idx_sales_orders_selfheal_partial
  ON public.sales_orders
     (user_id, order_status, purchase_timestamp_utc DESC NULLS LAST, order_date DESC)
  WHERE (sold_price IS NULL OR sold_price = 0)
    AND (price_source LIKE 'estimated:%' OR price_source IS NULL);

-- Attempt 1, dropped. Never used by any plan; pure write cost on a table that
-- takes constant inserts.
DROP INDEX IF EXISTS public.idx_sales_orders_selfheal_pending;
