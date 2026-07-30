-- Priority Queue star cap (frontend MAX_PRIORITY) and the priority cron's
-- SP-API budget (repricer_settings.sp_api_calls_per_minute_cap) were both
-- flat constants for every account (10 and 10/20/30-via-manual-migration
-- respectively), with no relationship to plan size. Investigation showed
-- the cron's actual throughput is derived from sp_api_calls_per_minute_cap
-- (budget / 2 calls per ASIN check), so scaling that column per plan is
-- what actually changes priority-queue speed -- the star cap just needs to
-- stay roughly in step with it so every starred ASIN still gets a full
-- pass about once a minute (star_cap ~= sp_api_calls_per_minute_cap / 2).
--
-- Values are deliberately sub-linear vs listing_limit: a naive linear scale
-- (e.g. 1000->10, 4000->40, unlimited->200+) would push priority-cron alone
-- past 400 SP-API calls/min for the top tier, which real Amazon per-operation
-- rate limits (fractional req/sec, shared account-wide with regular sync/
-- dispatch traffic) can't sustain. These stay bounded even for "unlimited".

ALTER TABLE public.subscription_plans
  ADD COLUMN IF NOT EXISTS priority_star_cap integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS sp_api_calls_per_minute_cap integer NOT NULL DEFAULT 10;

UPDATE public.subscription_plans SET priority_star_cap = 5,  sp_api_calls_per_minute_cap = 10 WHERE id = 'starter';
UPDATE public.subscription_plans SET priority_star_cap = 8,  sp_api_calls_per_minute_cap = 16 WHERE id = 'growth';
UPDATE public.subscription_plans SET priority_star_cap = 12, sp_api_calls_per_minute_cap = 24 WHERE id = 'pro';
UPDATE public.subscription_plans SET priority_star_cap = 16, sp_api_calls_per_minute_cap = 32 WHERE id = 'advanced';
UPDATE public.subscription_plans SET priority_star_cap = 20, sp_api_calls_per_minute_cap = 40 WHERE id = 'unlimited';

-- Backfill: only touch accounts still sitting on the old blanket default of
-- 10 -- any account already manually tuned away from that (e.g. the admin
-- test account, bumped to 30 via earlier migrations) is left untouched.
UPDATE public.repricer_settings rs
SET sp_api_calls_per_minute_cap = sp.sp_api_calls_per_minute_cap
FROM public.user_subscriptions us
JOIN public.subscription_plans sp ON sp.id = us.plan_id
WHERE rs.user_id = us.user_id
  AND rs.sp_api_calls_per_minute_cap = 10;

-- Keep repricer_settings in sync going forward: when a user's plan actually
-- changes, re-derive their SP-API budget from the new plan's default.
CREATE OR REPLACE FUNCTION public.fn_sync_sp_api_cap_from_plan()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cap integer;
BEGIN
  SELECT sp_api_calls_per_minute_cap INTO v_cap
  FROM public.subscription_plans
  WHERE id = NEW.plan_id;

  IF v_cap IS NOT NULL THEN
    UPDATE public.repricer_settings
    SET sp_api_calls_per_minute_cap = v_cap
    WHERE user_id = NEW.user_id;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_sync_sp_api_cap_from_plan ON public.user_subscriptions;
CREATE TRIGGER trg_sync_sp_api_cap_from_plan
  AFTER INSERT OR UPDATE OF plan_id ON public.user_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.fn_sync_sp_api_cap_from_plan();
