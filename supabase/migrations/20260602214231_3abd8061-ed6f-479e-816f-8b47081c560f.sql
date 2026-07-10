CREATE INDEX IF NOT EXISTS idx_repricer_assignments_restock_reentry_partial
  ON public.repricer_assignments (restock_reentry_at)
  WHERE restock_reentry_at IS NOT NULL;