-- Create personalhour_orders table for tracking FBM orders and settlements
CREATE TABLE public.personalhour_orders (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  asin TEXT NOT NULL,
  title TEXT,
  image_url TEXT,
  price NUMERIC(10, 2),
  sales_tax NUMERIC(10, 2) DEFAULT 0,
  amazon_fee_fbm NUMERIC(10, 2),
  commission NUMERIC(10, 2) DEFAULT 0,
  amount_owed NUMERIC(10, 2),
  order_created_date DATE NOT NULL,
  settled BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable Row Level Security
ALTER TABLE public.personalhour_orders ENABLE ROW LEVEL SECURITY;

-- Create policies for user access
CREATE POLICY "Users can view their own orders"
ON public.personalhour_orders
FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own orders"
ON public.personalhour_orders
FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own orders"
ON public.personalhour_orders
FOR UPDATE
USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own orders"
ON public.personalhour_orders
FOR DELETE
USING (auth.uid() = user_id);

-- Create trigger for automatic timestamp updates
CREATE TRIGGER update_personalhour_orders_updated_at
BEFORE UPDATE ON public.personalhour_orders
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Create index for faster queries
CREATE INDEX idx_personalhour_orders_user_id ON public.personalhour_orders(user_id);
CREATE INDEX idx_personalhour_orders_asin ON public.personalhour_orders(asin);
CREATE INDEX idx_personalhour_orders_settled ON public.personalhour_orders(settled);
CREATE INDEX idx_personalhour_orders_order_date ON public.personalhour_orders(order_created_date);