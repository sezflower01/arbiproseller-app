
-- Phase 2.5: Lightweight effectiveness tracking on recommendations
ALTER TABLE public.smart_engine_tuning_recommendations
  ADD COLUMN IF NOT EXISTS model_tier text,
  ADD COLUMN IF NOT EXISTS confidence_bucket text,
  ADD COLUMN IF NOT EXISTS was_applied boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS applied_at timestamptz,
  ADD COLUMN IF NOT EXISTS outcome_direction text,
  ADD COLUMN IF NOT EXISTS outcome_evaluated_at timestamptz,
  ADD COLUMN IF NOT EXISTS outcome_notes jsonb;

-- Constrain the small enums (lightweight, additive)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ck_ser_outcome_direction'
  ) THEN
    ALTER TABLE public.smart_engine_tuning_recommendations
      ADD CONSTRAINT ck_ser_outcome_direction
      CHECK (outcome_direction IS NULL OR outcome_direction IN ('improved','neutral','worse','inconclusive'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ck_ser_confidence_bucket'
  ) THEN
    ALTER TABLE public.smart_engine_tuning_recommendations
      ADD CONSTRAINT ck_ser_confidence_bucket
      CHECK (confidence_bucket IS NULL OR confidence_bucket IN ('high','medium','low'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ck_ser_model_tier'
  ) THEN
    ALTER TABLE public.smart_engine_tuning_recommendations
      ADD CONSTRAINT ck_ser_model_tier
      CHECK (model_tier IS NULL OR model_tier IN ('pro','flash','skip'));
  END IF;
END$$;

-- Helpful index for tier-quality reporting
CREATE INDEX IF NOT EXISTS idx_ser_tier_outcome
  ON public.smart_engine_tuning_recommendations (model_tier, was_applied, outcome_direction);

-- Backfill confidence_bucket from existing confidence_score (one-time, idempotent)
UPDATE public.smart_engine_tuning_recommendations
SET confidence_bucket = CASE
  WHEN confidence_score >= 0.75 THEN 'high'
  WHEN confidence_score >= 0.45 THEN 'medium'
  WHEN confidence_score IS NOT NULL THEN 'low'
  ELSE NULL
END
WHERE confidence_bucket IS NULL;

-- Backfill was_applied / applied_at from prior applications
UPDATE public.smart_engine_tuning_recommendations r
SET was_applied = true,
    applied_at = COALESCE(r.applied_at, ta.applied_at)
FROM public.smart_engine_tuning_actions ta
WHERE ta.recommendation_id = r.id
  AND r.was_applied = false;
