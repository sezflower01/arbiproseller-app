-- Resolve RPC ambiguity causing PGRST203 by removing overloaded timestamptz signature.
-- Keep the text signature, which matches generated Supabase client types and current frontend call payloads.
DROP FUNCTION IF EXISTS public.get_sellerboard_period_totals(timestamp with time zone, timestamp with time zone);