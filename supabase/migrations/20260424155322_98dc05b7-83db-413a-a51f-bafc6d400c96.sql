ALTER TABLE public.shipment_builder_drafts
ADD COLUMN IF NOT EXISTS amazon_operation_id TEXT,
ADD COLUMN IF NOT EXISTS amazon_plan_status TEXT;

CREATE INDEX IF NOT EXISTS idx_shipment_builder_drafts_user_plan_status
ON public.shipment_builder_drafts (user_id, amazon_plan_status, updated_at DESC);