
ALTER TABLE public.repricer_assignments
ADD COLUMN IF NOT EXISTS delta_too_small_streak integer NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS no_bb_progress_streak integer NOT NULL DEFAULT 0;
