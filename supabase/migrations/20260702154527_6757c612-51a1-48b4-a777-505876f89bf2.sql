CREATE TABLE IF NOT EXISTS public.amazon_oauth_states (
  state text PRIMARY KEY,
  user_id uuid NOT NULL,
  marketplace_id text NOT NULL DEFAULT 'ATVPDKIKX0DER',
  origin text,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.amazon_oauth_states TO service_role;

ALTER TABLE public.amazon_oauth_states ENABLE ROW LEVEL SECURITY;

-- No policies for anon/authenticated — table is service-role only, used exclusively
-- by amazon-oauth-start and amazon-oauth-callback edge functions.

CREATE INDEX IF NOT EXISTS amazon_oauth_states_created_at_idx
  ON public.amazon_oauth_states (created_at);