-- Several edge functions upsert with an onConflict target that was never
-- backed by a real UNIQUE constraint, throwing 42P10 on every call.
-- Verified via live duplicate-row checks before adding each constraint --
-- all clean, no pre-existing duplicates block any of these.

-- sales_orders: two independent natural keys are in use --
-- (user_id, order_id, asin) for order line items, and
-- (user_id, fec_refund_key) for refund rows (fec_refund_key is NULL for
-- non-refund rows, and Postgres UNIQUE treats NULLs as distinct, so this
-- doesn't conflict with plain order rows).
ALTER TABLE public.sales_orders
  ADD CONSTRAINT sales_orders_user_order_asin_key UNIQUE (user_id, order_id, asin);
ALTER TABLE public.sales_orders
  ADD CONSTRAINT sales_orders_user_fec_refund_key_key UNIQUE (user_id, fec_refund_key);

-- inventory: (user_id, sku) is the key every writer already assumes.
ALTER TABLE public.inventory
  ADD CONSTRAINT inventory_user_sku_key UNIQUE (user_id, sku);

-- repricer_strategic_insights: dedupe_key is the writer's own dedup token.
ALTER TABLE public.repricer_strategic_insights
  ADD CONSTRAINT repricer_strategic_insights_user_dedupe_key UNIQUE (user_id, dedupe_key);

-- ghost_sku_quarantine: best-effort archival keyed by how it was quarantined.
ALTER TABLE public.ghost_sku_quarantine
  ADD CONSTRAINT ghost_sku_quarantine_user_asin_sku_fn_key UNIQUE (user_id, asin, seller_sku, source_function);

-- store_scan_items: two alternate keys depending on whether a normalized
-- url_key was computable for a given scanned link; both currently rely on
-- a select+update/insert fallback because neither constraint exists.
ALTER TABLE public.store_scan_items
  ADD CONSTRAINT store_scan_items_run_urlkey_key UNIQUE (run_id, url_key);
ALTER TABLE public.store_scan_items
  ADD CONSTRAINT store_scan_items_run_sourceurl_key UNIQUE (run_id, source_url);
