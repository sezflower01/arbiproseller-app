-- Drop eight never-used indexes on repricer_price_actions (~441 MB).
--
-- WHY THIS IS WORTH DOING AT ALL
-- ------------------------------
-- The repricer writes to this table every minute. Every INSERT must update
-- EVERY index on it, and the table carried twenty. Eight of them have never
-- been read -- not "rarely", never -- so each insert was paying to maintain
-- 441 MB of structures nothing queries. That is write amplification and buffer
-- cache pressure on the hottest write path in the system, which is directly
-- relevant to the connection contention tracked as item 8.
--
-- EVIDENCE, and why the zeros are trustworthy
-- -------------------------------------------
-- Measured 2026-08-22 from pg_stat_user_indexes:
--
--   idx_rpa_created_at_action                  0 scans   108 MB
--   idx_repricer_price_actions_created         0 scans   106 MB
--   idx_rpa_intelligence_factors_gin           0 scans   106 MB
--   idx_rpa_sku                                0 scans    32 MB
--   idx_repricer_price_actions_reconciliation  0 scans    28 MB
--   idx_rpa_rule_name                          0 scans    25 MB
--   idx_repricer_price_actions_error_type      0 scans    24 MB
--   idx_price_actions_unnecessary_undercut     0 scans    12 MB
--
-- idx_scan is cumulative since the last statistics reset, so a zero is only
-- meaningful if the window is long. pg_stat_database.stats_reset is NULL for
-- this database -- statistics have never been reset. And the same counters
-- recorded 1,012,943 scans on idx_repricer_price_actions_created_at over that
-- window, so it is emphatically not a short one.
--
-- Note the near-duplicate pairs this exposes, where one of each is hot and the
-- other has never been touched:
--   idx_repricer_price_actions_created      0 scans  vs
--   idx_repricer_price_actions_created_at   1,012,943 scans
--   idx_rpa_created_at_action               0 scans  vs
--   idx_rpa_action_type_created_at          46,570 scans
--
-- WHAT IS DELIBERATELY NOT DROPPED
-- --------------------------------
-- repricer_price_actions_pkey also reports 0 scans. It is the PRIMARY KEY.
-- Zero scans means nothing looks rows up by id; the index still enforces
-- uniqueness, and dropping it would be destructive. Never drop an index on
-- scan count alone without checking what constraint it backs.
--
-- idx_repricer_price_actions_lookup is NOT dropped either, despite being
-- provably unusable for the time-anchored query it appears to have been built
-- for (see 20260822190000). It has 3,298 scans, so another caller uses it
-- legitimately. The reasoning that it cannot serve one query says nothing
-- about whether it serves others.
--
-- idx_price_actions_feed_id has 0 scans but occupies 8192 bytes -- a partial
-- index over a nearly empty predicate. Dropping it saves nothing measurable
-- and it relates to the feed sweeps, so it is left alone.
--
-- Worth keeping in view as a counter-example to "small index, low value":
-- idx_rpa_restock_reentry_partial and idx_rpa_restock_ilike_partial are 8192
-- bytes each and have ~95,750 scans apiece. Tightly scoped partial indexes are
-- the cheapest thing in this table and among the most used.
--
-- APPLYING THIS TO A LIVE DATABASE
-- --------------------------------
-- Plain DROP INDEX takes a brief ACCESS EXCLUSIVE lock on the table, which
-- must wait behind any in-flight query. On a table written every minute,
-- prefer running these by hand as DROP INDEX CONCURRENTLY, one statement at a
-- time -- CONCURRENTLY cannot run inside a transaction block, and migrations
-- run in one. The IF EXISTS clauses below then no-op on the live database and
-- keep other environments in step.

DROP INDEX IF EXISTS public.idx_rpa_created_at_action;
DROP INDEX IF EXISTS public.idx_repricer_price_actions_created;
DROP INDEX IF EXISTS public.idx_rpa_intelligence_factors_gin;
DROP INDEX IF EXISTS public.idx_rpa_sku;
DROP INDEX IF EXISTS public.idx_repricer_price_actions_reconciliation;
DROP INDEX IF EXISTS public.idx_rpa_rule_name;
DROP INDEX IF EXISTS public.idx_repricer_price_actions_error_type;
DROP INDEX IF EXISTS public.idx_price_actions_unnecessary_undercut;
