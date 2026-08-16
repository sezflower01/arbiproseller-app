-- Learn the Keepa refill rate from the API instead of hardcoding it.
--
-- WHY: migration 20260815210000 created keepa_token_budget with
-- refill_per_min hardcoded to 5. That number is correct today -- measured
-- 2026-08-15, and confirmed three ways:
--
--   * refill arrived in discrete lumps of exactly +5, never +1
--   * refillIn reported 34-41s, i.e. one lump per minute
--   * tokensLeft peaked near 300, and a bucket caps at rate x 60 -- a
--     1 token/min plan caps at 60 and cannot physically hold the 290 we
--     observed
--
-- ...but hardcoding it repeats the exact mistake that caused the original
-- gate bug: assuming a rate rather than reading the one the API reports.
-- The Keepa Data subscription page advertises 1 token/min with higher rates
-- requiring a separate API plan, so the effective rate is a property of
-- account billing, not of this codebase, and it can change without any
-- deploy.
--
-- If the real rate dropped to 1/min while this table still said 5, the
-- bucket would credit refill five times too fast and hand out calls Keepa
-- rejects with 429s. Every Keepa response carries refillRate, so the gate
-- can simply learn it -- the same self-correcting principle already used
-- for tokensLeft.

ALTER TABLE public.keepa_token_budget
  ADD COLUMN IF NOT EXISTS refill_observed_at timestamptz;

-- Extends observe_keepa_tokens with an optional observed refill rate.
-- Kept as the same function name with a defaulted second argument so the
-- previous single-argument signature keeps working during a rolling deploy.
CREATE OR REPLACE FUNCTION public.observe_keepa_tokens(
  p_tokens_left numeric,
  p_refill_rate numeric DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rate numeric;
BEGIN
  -- Ignore absent or nonsensical values rather than letting one malformed
  -- response knock the budget into a state that starves every caller.
  IF p_refill_rate IS NOT NULL AND p_refill_rate > 0 AND p_refill_rate <= 10000 THEN
    v_rate := p_refill_rate;
  END IF;

  INSERT INTO public.keepa_token_budget (id, tokens_left, last_observed_at, updated_at)
  VALUES (true, p_tokens_left, now(), now())
  ON CONFLICT (id) DO UPDATE
    SET tokens_left      = EXCLUDED.tokens_left,
        last_observed_at = now(),
        updated_at       = now(),
        -- Bucket ceiling is rate x 60 by definition; keep it consistent so a
        -- rate change cannot leave a stale ceiling over-crediting refill.
        refill_per_min   = COALESCE(v_rate, public.keepa_token_budget.refill_per_min),
        bucket_max       = CASE WHEN v_rate IS NOT NULL THEN v_rate * 60
                                ELSE public.keepa_token_budget.bucket_max END,
        refill_observed_at = CASE WHEN v_rate IS NOT NULL THEN now()
                                  ELSE public.keepa_token_budget.refill_observed_at END;
END;
$$;

REVOKE ALL ON FUNCTION public.observe_keepa_tokens(numeric, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.observe_keepa_tokens(numeric, numeric) TO service_role;
