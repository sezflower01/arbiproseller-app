-- Durable progress tracking for full-inventory-refresh-all, added to prove
-- and then fix the same silent-kill risk found in sync-fnsku-report earlier
-- today: this function previously had ONLY console.log "heartbeats" (no
-- durable table at all), so a mid-run kill by the ~150s edge-runtime
-- ceiling was completely invisible -- no row anywhere shows it started,
-- how far it got, or that it silently died.
CREATE TABLE IF NOT EXISTS public.full_inventory_refresh_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_tag text NOT NULL,
  status text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed', 'failed', 'timed_out')),
  scope text NOT NULL,
  user_ids jsonb NOT NULL,
  user_cursor integer NOT NULL DEFAULT 0,
  item_cursor integer NOT NULL DEFAULT 0,
  current_user_item_count integer,
  grand_checked integer NOT NULL DEFAULT 0,
  grand_ok integer NOT NULL DEFAULT 0,
  grand_err integer NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  last_heartbeat_at timestamptz,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_full_inv_refresh_runs_status
  ON public.full_inventory_refresh_runs (status, last_heartbeat_at);

GRANT ALL ON public.full_inventory_refresh_runs TO service_role;
