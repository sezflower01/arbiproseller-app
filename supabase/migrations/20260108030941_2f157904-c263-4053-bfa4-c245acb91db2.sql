-- Add shipment_day column for Sellerboard-like behavior (label purchase/shipment creation day)
ALTER TABLE public.fba_inbound_fees 
ADD COLUMN IF NOT EXISTS shipment_day date;

-- Add comment explaining the two date fields
COMMENT ON COLUMN public.fba_inbound_fees.posted_date IS 'Amazon PostedDate - when Amazon posted the fee to financial events (may be delayed)';
COMMENT ON COLUMN public.fba_inbound_fees.shipment_day IS 'Operational day - shipment creation/confirmation date for Sellerboard-like grouping. Falls back to posted_date if unknown.';

-- Create index for efficient queries by shipment_day
CREATE INDEX IF NOT EXISTS idx_fba_inbound_fees_shipment_day 
ON public.fba_inbound_fees(user_id, shipment_day);

-- Create index for efficient queries by posted_date (already may exist but ensure it)
CREATE INDEX IF NOT EXISTS idx_fba_inbound_fees_posted_date 
ON public.fba_inbound_fees(user_id, posted_date);