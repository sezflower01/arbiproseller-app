
-- Add recovery outcome tracking for removed inventory (restricted, sold elsewhere, disposed, etc.)
CREATE TYPE public.disposition_outcome AS ENUM (
  'pending',
  'returned_to_inventory',
  'sold_elsewhere',
  'disposed',
  'partial_recovery',
  'restricted_unsold'
);

ALTER TABLE public.inventory_dispositions
  ADD COLUMN IF NOT EXISTS outcome public.disposition_outcome NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS recovery_channel text,
  ADD COLUMN IF NOT EXISTS recovery_notes text,
  ADD COLUMN IF NOT EXISTS outcome_recorded_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_inventory_dispositions_outcome
  ON public.inventory_dispositions(user_id, outcome);

COMMENT ON COLUMN public.inventory_dispositions.outcome IS
  'Business outcome for removed/returned units. Drives true business loss calculation beyond Amazon report.';
COMMENT ON COLUMN public.inventory_dispositions.recovery_channel IS
  'Where units were recovered/sold (eBay, Walmart, local, donation, etc.)';
