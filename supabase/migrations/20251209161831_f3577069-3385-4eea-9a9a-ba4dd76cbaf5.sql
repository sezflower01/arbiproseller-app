-- Create table for FBA shipments
CREATE TABLE public.fba_shipments (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  shipment_id TEXT NOT NULL,
  shipment_name TEXT,
  destination_fulfillment_center_id TEXT,
  shipment_status TEXT,
  label_prep_type TEXT,
  are_cases_required BOOLEAN DEFAULT false,
  confirmed_need_by_date DATE,
  box_contents_source TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(user_id, shipment_id)
);

-- Create table for shipment items
CREATE TABLE public.fba_shipment_items (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  shipment_id TEXT NOT NULL,
  user_id UUID NOT NULL,
  seller_sku TEXT NOT NULL,
  fnsku TEXT,
  asin TEXT,
  title TEXT,
  image_url TEXT,
  quantity_shipped INTEGER DEFAULT 0,
  quantity_received INTEGER DEFAULT 0,
  quantity_in_case INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(user_id, shipment_id, seller_sku)
);

-- Enable RLS
ALTER TABLE public.fba_shipments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fba_shipment_items ENABLE ROW LEVEL SECURITY;

-- RLS policies for fba_shipments
CREATE POLICY "Users can manage their own shipments"
ON public.fba_shipments
FOR ALL
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

-- RLS policies for fba_shipment_items
CREATE POLICY "Users can manage their own shipment items"
ON public.fba_shipment_items
FOR ALL
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

-- Add indexes for performance
CREATE INDEX idx_fba_shipments_user_id ON public.fba_shipments(user_id);
CREATE INDEX idx_fba_shipments_status ON public.fba_shipments(shipment_status);
CREATE INDEX idx_fba_shipment_items_shipment_id ON public.fba_shipment_items(shipment_id);
CREATE INDEX idx_fba_shipment_items_user_id ON public.fba_shipment_items(user_id);