ALTER TABLE public.gmail_connections DROP CONSTRAINT IF EXISTS gmail_connections_user_id_key;
ALTER TABLE public.gmail_connections ADD CONSTRAINT gmail_connections_user_email_key UNIQUE (user_id, email);
CREATE INDEX IF NOT EXISTS gmail_connections_user_id_idx ON public.gmail_connections(user_id);