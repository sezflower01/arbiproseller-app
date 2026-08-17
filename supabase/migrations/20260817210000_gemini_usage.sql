-- Visibility for Gemini, which had none.
--
-- Same class of bug fixed for Keepa earlier today: every Gemini call site did
--   if (!resp.ok) return null;
-- so a 429 was indistinguishable from "the model had no opinion". In
-- find-source-candidates that quietly degraded a candidate's reason to "Based
-- on text match only" and dropped the AI weighting from its confidence score.
-- A quota outage rendered as a weaker match, with nothing anywhere saying the
-- AI had not run.
--
-- One row per day. Counters only -- Gemini's own quota lives at Google and this
-- does not try to mirror it. What it answers is "did our calls start failing,
-- when, and with what status", which is the question that could not be answered
-- at all before.
CREATE TABLE IF NOT EXISTS public.gemini_daily_usage (
  usage_date date PRIMARY KEY DEFAULT CURRENT_DATE,
  call_count bigint NOT NULL DEFAULT 0,
  success_count bigint NOT NULL DEFAULT 0,
  -- 429 specifically: rate limit or exhausted quota. The actionable one.
  quota_failure_count bigint NOT NULL DEFAULT 0,
  -- Everything else non-2xx: auth, 5xx, malformed.
  other_failure_count bigint NOT NULL DEFAULT 0,
  last_failure_at timestamptz,
  last_failure_status integer,
  last_failure_caller text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.gemini_daily_usage ENABLE ROW LEVEL SECURITY;

-- Account-wide like keepa_daily_usage: the Gemini key is one key for the whole
-- deployment, not per user, so there is nothing to scope by user_id.
DROP POLICY IF EXISTS "gemini_daily_usage read" ON public.gemini_daily_usage;
CREATE POLICY "gemini_daily_usage read" ON public.gemini_daily_usage
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "gemini_daily_usage service" ON public.gemini_daily_usage;
CREATE POLICY "gemini_daily_usage service" ON public.gemini_daily_usage
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Atomic, so concurrent verifications cannot lose an increment the way a
-- read-then-write would. Keepa's 429 recorder does read-then-write and can
-- undercount under load; this one does not repeat that.
CREATE OR REPLACE FUNCTION public.record_gemini_call(
  p_ok boolean,
  p_status integer DEFAULT NULL,
  p_caller text DEFAULT NULL
)
RETURNS void
LANGUAGE sql
SET search_path = public
AS $$
  INSERT INTO public.gemini_daily_usage AS g (
    usage_date, call_count, success_count, quota_failure_count, other_failure_count,
    last_failure_at, last_failure_status, last_failure_caller, updated_at
  )
  VALUES (
    CURRENT_DATE, 1,
    CASE WHEN p_ok THEN 1 ELSE 0 END,
    CASE WHEN NOT p_ok AND p_status = 429 THEN 1 ELSE 0 END,
    CASE WHEN NOT p_ok AND (p_status IS DISTINCT FROM 429) THEN 1 ELSE 0 END,
    CASE WHEN p_ok THEN NULL ELSE now() END,
    CASE WHEN p_ok THEN NULL ELSE p_status END,
    CASE WHEN p_ok THEN NULL ELSE p_caller END,
    now()
  )
  ON CONFLICT (usage_date) DO UPDATE SET
    call_count          = g.call_count + 1,
    success_count       = g.success_count + CASE WHEN p_ok THEN 1 ELSE 0 END,
    quota_failure_count = g.quota_failure_count + CASE WHEN NOT p_ok AND p_status = 429 THEN 1 ELSE 0 END,
    other_failure_count = g.other_failure_count + CASE WHEN NOT p_ok AND (p_status IS DISTINCT FROM 429) THEN 1 ELSE 0 END,
    last_failure_at     = CASE WHEN p_ok THEN g.last_failure_at ELSE now() END,
    last_failure_status = CASE WHEN p_ok THEN g.last_failure_status ELSE p_status END,
    last_failure_caller = CASE WHEN p_ok THEN g.last_failure_caller ELSE p_caller END,
    updated_at          = now();
$$;

REVOKE ALL ON FUNCTION public.record_gemini_call(boolean, integer, text) FROM public;
GRANT EXECUTE ON FUNCTION public.record_gemini_call(boolean, integer, text) TO service_role;
