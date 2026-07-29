-- Seed approximate static FX rates for the EU/other currencies now selectable
-- in the admin marketplace simulation tool, so previewing e.g. Germany
-- actually shows converted amounts instead of a "€" symbol with unconverted
-- (1:1) numbers. Same table/mechanism already used for CAD/MXN/BRL — this is
-- display-preview data, not new repricer/SP-API/fee-cache business logic.
INSERT INTO public.fx_rates (base, quote, rate, source) VALUES
  ('USD', 'EUR', 0.92, 'initial'),
  ('USD', 'GBP', 0.79, 'initial'),
  ('USD', 'SEK', 10.50, 'initial'),
  ('USD', 'PLN', 4.00, 'initial'),
  ('USD', 'TRY', 34.50, 'initial')
ON CONFLICT (base, quote) DO NOTHING;
