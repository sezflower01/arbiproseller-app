
ALTER TABLE public.sync_locks ENABLE ROW LEVEL SECURITY;

-- No public policies - only service_role (edge functions) can access this table
