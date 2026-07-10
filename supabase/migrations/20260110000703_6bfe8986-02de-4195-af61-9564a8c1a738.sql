-- Drop the conflicting unique indexes to simplify
DROP INDEX IF EXISTS fba_inbound_fees_unique_fee;
DROP INDEX IF EXISTS idx_fba_inbound_fees_unique;

-- Store the full posted_date timestamp (with time) for accurate timezone conversion
-- Add column for the full timestamp if needed for re-processing
ALTER TABLE fba_inbound_fees ADD COLUMN IF NOT EXISTS posted_date_utc timestamptz;

-- Create a simpler unique constraint that Supabase can use with ON CONFLICT
-- Use just the core identifying fields: user_id, fee_type, fee_amount, posted_date
ALTER TABLE fba_inbound_fees DROP CONSTRAINT IF EXISTS fba_inbound_fees_upsert_key;
ALTER TABLE fba_inbound_fees ADD CONSTRAINT fba_inbound_fees_upsert_key 
  UNIQUE (user_id, fee_type, fee_amount, posted_date);