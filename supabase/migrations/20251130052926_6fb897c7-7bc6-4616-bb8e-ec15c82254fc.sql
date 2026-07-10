-- Create sales_orders table to track Amazon sales
CREATE TABLE IF NOT EXISTS public.sales_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  order_id TEXT NOT NULL,
  asin TEXT NOT NULL,
  sku TEXT,
  title TEXT,
  image_url TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  sold_price NUMERIC NOT NULL,
  total_sale_amount NUMERIC NOT NULL,
  referral_fee NUMERIC NOT NULL DEFAULT 0,
  fba_fee NUMERIC NOT NULL DEFAULT 0,
  closing_fee NUMERIC NOT NULL DEFAULT 0,
  total_fees NUMERIC NOT NULL DEFAULT 0,
  unit_cost NUMERIC,
  total_cost NUMERIC,
  roi NUMERIC,
  order_date DATE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Create unique index on user_id, order_id, and asin to prevent duplicate order items
CREATE UNIQUE INDEX IF NOT EXISTS sales_orders_user_order_asin_idx ON public.sales_orders(user_id, order_id, asin);

-- Enable RLS
ALTER TABLE public.sales_orders ENABLE ROW LEVEL SECURITY;

-- Users can manage their own sales orders
CREATE POLICY "Users can manage their own sales orders"
ON public.sales_orders
FOR ALL
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

-- Create trigger for updated_at
CREATE TRIGGER update_sales_orders_updated_at
BEFORE UPDATE ON public.sales_orders
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();