ALTER TABLE public.inventory
  ADD COLUMN IF NOT EXISTS inbound_working integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS inbound_receiving integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS inbound_shipped integer NOT NULL DEFAULT 0;