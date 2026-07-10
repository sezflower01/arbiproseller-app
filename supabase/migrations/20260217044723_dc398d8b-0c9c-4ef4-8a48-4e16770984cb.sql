-- Add fulfillment_channel to track FBA vs FBM orders
ALTER TABLE public.sales_orders
ADD COLUMN IF NOT EXISTS fulfillment_channel text DEFAULT NULL;

-- Add comment for documentation
COMMENT ON COLUMN public.sales_orders.fulfillment_channel IS 'AFN = FBA (Amazon Fulfilled), MFN = FBM (Merchant Fulfilled). From Amazon Orders API FulfillmentChannel field.';