-- Create fx_rates table to store exchange rates
CREATE TABLE public.fx_rates (
  base TEXT NOT NULL DEFAULT 'USD',
  quote TEXT NOT NULL,
  rate NUMERIC NOT NULL DEFAULT 1,
  as_of TIMESTAMPTZ NOT NULL DEFAULT now(),
  source TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (base, quote)
);

-- Enable RLS
ALTER TABLE public.fx_rates ENABLE ROW LEVEL SECURITY;

-- Everyone can read FX rates (public data)
CREATE POLICY "Anyone can view fx_rates"
ON public.fx_rates
FOR SELECT
USING (true);

-- Only service role can manage rates (scheduled job)
CREATE POLICY "Service role can manage fx_rates"
ON public.fx_rates
FOR ALL
USING (auth.role() = 'service_role')
WITH CHECK (auth.role() = 'service_role');

-- Trigger for updated_at
CREATE TRIGGER update_fx_rates_updated_at
BEFORE UPDATE ON public.fx_rates
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Insert initial rates (will be updated by scheduled job)
INSERT INTO public.fx_rates (base, quote, rate, source) VALUES
  ('USD', 'USD', 1, 'static'),
  ('USD', 'CAD', 1.44, 'initial'),
  ('USD', 'MXN', 20.50, 'initial'),
  ('USD', 'BRL', 6.20, 'initial');