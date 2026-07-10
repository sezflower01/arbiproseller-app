ALTER TABLE public.expenses
ADD COLUMN IF NOT EXISTS skipped_months text[] NOT NULL DEFAULT '{}';