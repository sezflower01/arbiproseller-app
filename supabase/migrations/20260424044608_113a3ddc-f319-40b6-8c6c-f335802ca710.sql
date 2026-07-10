-- Shipment Builder library: per-user persistence in Supabase
CREATE TABLE public.shipment_builder_drafts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  draft_id TEXT NOT NULL,
  shipment_name TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  step SMALLINT NOT NULL DEFAULT 1,
  creation_mode TEXT NOT NULL DEFAULT 'quantity-only',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  inbound_plan_id TEXT,
  amazon_shipment_id TEXT,
  placement_option_id TEXT,
  continued_to_amazon_at TIMESTAMPTZ,
  synced_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT shipment_builder_drafts_user_draft_unique UNIQUE (user_id, draft_id),
  CONSTRAINT shipment_builder_drafts_status_check CHECK (status IN ('draft','continued','synced','completed','archived'))
);

CREATE INDEX idx_shipment_builder_drafts_user_status ON public.shipment_builder_drafts (user_id, status, updated_at DESC);
CREATE INDEX idx_shipment_builder_drafts_user_updated ON public.shipment_builder_drafts (user_id, updated_at DESC);

ALTER TABLE public.shipment_builder_drafts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own shipment drafts"
ON public.shipment_builder_drafts FOR SELECT
USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Users can create their own shipment drafts"
ON public.shipment_builder_drafts FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own shipment drafts"
ON public.shipment_builder_drafts FOR UPDATE
USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own shipment drafts"
ON public.shipment_builder_drafts FOR DELETE
USING (auth.uid() = user_id);

CREATE TRIGGER update_shipment_builder_drafts_updated_at
BEFORE UPDATE ON public.shipment_builder_drafts
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();