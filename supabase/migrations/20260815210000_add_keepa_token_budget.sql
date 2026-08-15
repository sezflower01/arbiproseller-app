-- Token-aware Keepa budget accounting.
--
-- WHY: _shared/keepa-rate-gate.ts admits KEEPA_GUARD_LIMIT = 4 calls/min
-- against a plan that refills only 5 TOKENS/min. That calibration silently
-- assumes 1 call == 1 token. Measured live on 2026-08-15 via the
-- keepa-token-probe function, that assumption is wrong by an order of
-- magnitude or more:
--
--   /seller?storefront=1  = a flat 10 tokens (regardless of catalog size --
--                           238, 92 and 38-ASIN storefronts all cost 10)
--   /product              = 1 token PER ASIN, so the 50-ASIN batch in
--                           check-seller-watchlist costs 50
--   /product with offers  = more still (seller-storefront-snapshot requests
--                           offers=20&stats=90&buybox=1&stock=1)
--
-- So the call gate permits 4 x 10 = 40 tokens/min against a 5/min refill --
-- an 8x overdraw for seller calls and up to 40x for product batches, which
-- empties the ~300-token bucket in about 90 seconds. The gate cannot
-- protect the budget; it only appears to work because call volume is
-- currently low. repricer-sp-api-pricing draws on this same account, so a
-- burst from any other caller can starve live repricing with no error
-- surfaced anywhere (see the incident recorded in the header comment of
-- seller-storefront-snapshot/index.ts).
--
-- This migration adds real token accounting: a refilling bucket, atomic
-- claim-with-reservation, and a reconcile path that overwrites our estimate
-- with the tokensLeft value Keepa reports on every response.
--
-- Deliberately a SEPARATE table from keepa_daily_usage.last_called_at.
-- repricer-sp-api-pricing carries its own inline copy of the call gate and
-- is live/critical; changing the meaning of last_called_at underneath it
-- could throttle repricing in ways that are hard to predict. The call gate
-- stays exactly as it is and this budget check is layered on top of it.

CREATE TABLE IF NOT EXISTS public.keepa_token_budget (
  -- Single row: the Keepa plan is per-account, not per-user.
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  tokens_left numeric NOT NULL DEFAULT 300,
  refill_per_min numeric NOT NULL DEFAULT 5,
  bucket_max numeric NOT NULL DEFAULT 300,
  -- Observability: how often low-priority callers were held back.
  denied_count bigint NOT NULL DEFAULT 0,
  last_denied_at timestamptz,
  last_observed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.keepa_token_budget ENABLE ROW LEVEL SECURITY;

-- Service role only. Edge functions use the service key; nothing user-facing
-- should read or write the account-wide token budget.
DROP POLICY IF EXISTS "keepa_token_budget service role" ON public.keepa_token_budget;
CREATE POLICY "keepa_token_budget service role"
  ON public.keepa_token_budget FOR ALL
  TO service_role USING (true) WITH CHECK (true);

INSERT INTO public.keepa_token_budget (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- Atomically reserve p_tokens, refusing if it would take the balance below
-- p_min_reserve. The reserve is how background work (seller monitoring) is
-- kept from consuming the headroom live repricing depends on: low-priority
-- callers pass a floor, the repricer passes 0.
--
-- SECURITY DEFINER + row lock so concurrent edge function invocations cannot
-- both see the same balance and double-spend it.
CREATE OR REPLACE FUNCTION public.claim_keepa_tokens(
  p_tokens numeric,
  p_min_reserve numeric DEFAULT 0
)
RETURNS TABLE(allowed boolean, tokens_left numeric, wait_seconds integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.keepa_token_budget%ROWTYPE;
  v_projected numeric;
  v_deficit numeric;
BEGIN
  INSERT INTO public.keepa_token_budget (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

  SELECT * INTO v_row FROM public.keepa_token_budget WHERE id FOR UPDATE;

  -- ON CONFLICT DO NOTHING can leave a concurrently-inserted row outside this
  -- snapshot. Retry once, then fail OPEN: a rate gate that cannot read its own
  -- state must not become a hard stop on all Keepa traffic.
  IF NOT FOUND THEN
    INSERT INTO public.keepa_token_budget (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
    SELECT * INTO v_row FROM public.keepa_token_budget WHERE id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN QUERY SELECT true, NULL::numeric, 0;
      RETURN;
    END IF;
  END IF;

  -- Refill accrued since the last touch, capped at the bucket ceiling.
  v_projected := LEAST(
    v_row.bucket_max,
    v_row.tokens_left + (EXTRACT(EPOCH FROM (now() - v_row.updated_at)) / 60.0) * v_row.refill_per_min
  );

  IF v_projected - p_tokens >= p_min_reserve THEN
    UPDATE public.keepa_token_budget
       SET tokens_left = v_projected - p_tokens,
           updated_at  = now()
     WHERE id;
    RETURN QUERY SELECT true, (v_projected - p_tokens), 0;
  ELSE
    -- Persist the refill even on denial so the next caller sees an accurate
    -- balance, and report how long until the request could succeed.
    v_deficit := (p_tokens + p_min_reserve) - v_projected;
    UPDATE public.keepa_token_budget
       SET tokens_left    = v_projected,
           updated_at     = now(),
           denied_count   = v_row.denied_count + 1,
           last_denied_at = now()
     WHERE id;
    RETURN QUERY SELECT false, v_projected, CEIL((v_deficit / v_row.refill_per_min) * 60.0)::integer;
  END IF;
END;
$$;

-- Keepa reports tokensLeft on EVERY response. That is ground truth; our
-- pre-call estimate is not. Calling this after each request keeps estimate
-- drift from accumulating -- an under-estimated call cost self-corrects on
-- the very next response instead of silently inflating available budget.
--
-- Known benign race: with two calls in flight, the first response can
-- overwrite the second's reservation, briefly over-stating available tokens.
-- It self-corrects on the next observation, and erring toward Keepa's own
-- number is the right bias -- it already accounts for every call actually
-- made, which a local estimate never can.
CREATE OR REPLACE FUNCTION public.observe_keepa_tokens(p_tokens_left numeric)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.keepa_token_budget (id, tokens_left, last_observed_at, updated_at)
  VALUES (true, p_tokens_left, now(), now())
  ON CONFLICT (id) DO UPDATE
    SET tokens_left      = EXCLUDED.tokens_left,
        last_observed_at = now(),
        updated_at       = now();
END;
$$;

REVOKE ALL ON FUNCTION public.claim_keepa_tokens(numeric, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.observe_keepa_tokens(numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_keepa_tokens(numeric, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.observe_keepa_tokens(numeric) TO service_role;
