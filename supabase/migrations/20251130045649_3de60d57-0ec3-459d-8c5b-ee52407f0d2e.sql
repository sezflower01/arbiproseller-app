-- Add FBA inventory status columns to inventory table
ALTER TABLE public.inventory 
ADD COLUMN IF NOT EXISTS available integer DEFAULT 0,
ADD COLUMN IF NOT EXISTS reserved integer DEFAULT 0,
ADD COLUMN IF NOT EXISTS inbound integer DEFAULT 0,
ADD COLUMN IF NOT EXISTS unfulfilled integer DEFAULT 0;

COMMENT ON COLUMN public.inventory.available IS 'Quantity available for sale in FBA warehouses';
COMMENT ON COLUMN public.inventory.reserved IS 'Quantity reserved for customer orders';
COMMENT ON COLUMN public.inventory.inbound IS 'Quantity in transit to Amazon fulfillment centers';
COMMENT ON COLUMN public.inventory.unfulfilled IS 'Quantity in unfulfilled customer orders';