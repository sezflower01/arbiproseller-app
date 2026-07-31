-- Lets an EXTERNAL sweep (its own independent execution/trace) resume a
-- stalled prewarm-profit-loss-all run without needing user_ids/offset
-- handed to it -- mirrors the same live-discovered gap as
-- full-inventory-refresh-all: the in-band selfContinue() call shares the
-- same execution/trace as the work that tripped the platform's
-- outbound-call quota, so it reliably fails too, orphaning the run.
ALTER TABLE public.prewarm_pl_runs
  ADD COLUMN IF NOT EXISTS user_ids jsonb,
  ADD COLUMN IF NOT EXISTS offset_idx integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_heartbeat_at timestamptz,
  ADD COLUMN IF NOT EXISTS timed_out boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_prewarm_pl_runs_unfinished
  ON public.prewarm_pl_runs (finished_at, last_heartbeat_at)
  WHERE finished_at IS NULL;
