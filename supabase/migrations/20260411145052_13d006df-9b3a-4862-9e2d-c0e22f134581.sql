-- Table for auto-generated invoices (admin/owner $0 invoices)
CREATE TABLE public.generated_invoices (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  invoice_number TEXT NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  product_name TEXT NOT NULL DEFAULT 'ArbiProSeller',
  amount NUMERIC NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'paid',
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  due_date DATE NOT NULL DEFAULT CURRENT_DATE,
  pdf_path TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, period_start)
);

-- Enable RLS
ALTER TABLE public.generated_invoices ENABLE ROW LEVEL SECURITY;

-- Users can view their own invoices
CREATE POLICY "Users can view own invoices"
  ON public.generated_invoices
  FOR SELECT
  USING (auth.uid() = user_id);

-- Admins can view all invoices
CREATE POLICY "Admins can view all invoices"
  ON public.generated_invoices
  FOR SELECT
  USING (public.has_role(auth.uid(), 'admin'));

-- Create sequence for invoice numbering
CREATE SEQUENCE IF NOT EXISTS generated_invoice_seq START WITH 1;

-- Trigger for updated_at
CREATE TRIGGER update_generated_invoices_updated_at
  BEFORE UPDATE ON public.generated_invoices
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();