-- Live evidence: repricer-business-advisor's upsert onConflict: 'user_id,dedupe_key'
-- has been failing on every call with 42P10 "no unique or exclusion constraint
-- matching the ON CONFLICT specification" since the dedupe_key migration
-- (2026-05-13) made the backing index partial (WHERE dedupe_key IS NOT NULL).
-- Postgres will not infer a partial index from a plain ON CONFLICT (columns)
-- clause, so every insight generated has silently failed to persist. The
-- caller never checked the upsert error, so this went unnoticed.
--
-- dedupe_key is always populated by the app (dedupeKey() never returns null),
-- so the partial predicate was never actually needed -- replacing it with a
-- full unique index makes the existing ON CONFLICT clause work correctly.
DROP INDEX IF EXISTS public.uq_insights_user_dedupe;

CREATE UNIQUE INDEX IF NOT EXISTS uq_insights_user_dedupe
  ON public.repricer_strategic_insights(user_id, dedupe_key);
