ALTER TABLE public.financial_events_cache
  ADD COLUMN IF NOT EXISTS fbm_shipping_label_fee numeric NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.financial_events_cache.fbm_shipping_label_fee IS
  'Amazon Buy Shipping label cost (FBM). Sourced from ServiceFeeEvent FeeReason=ShippingServices/ShippingLabelPurchase or negative ShippingCharge on ShipmentEvent. Distinct from fba_inbound_fees (FBA inbound transportation).';

CREATE INDEX IF NOT EXISTS idx_fec_fbm_shipping_label_fee
  ON public.financial_events_cache (user_id, event_date)
  WHERE fbm_shipping_label_fee <> 0;