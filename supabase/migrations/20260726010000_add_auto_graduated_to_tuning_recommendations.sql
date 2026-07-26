-- Marks recommendations that skipped manual review because their
-- recommendation_type had already proven itself (>=3 "improved" outcomes,
-- 0 "worse" outcomes, from prior experiments run via smart-engine-apply-tuning).
-- Graduation is tracked platform-wide per recommendation_type, not per user --
-- once a tuning pattern is proven safe, new accounts benefit immediately
-- instead of each having to re-earn trust from scratch.
ALTER TABLE public.smart_engine_tuning_recommendations
  ADD COLUMN IF NOT EXISTS auto_graduated boolean NOT NULL DEFAULT false;
