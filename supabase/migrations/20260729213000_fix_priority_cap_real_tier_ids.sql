-- 20260729210000_scale_priority_cap_by_plan.sql seeded priority_star_cap /
-- sp_api_calls_per_minute_cap using the ORIGINAL 5-tier plan ids
-- (starter/growth/pro/advanced/unlimited). Those were renamed to
-- tier_100..tier_50000 back in 20260403220616_...sql, so every real plan
-- row (all 9 tier_* rows) silently kept the column DEFAULT (5, 10) instead
-- of a tier-scaled value -- only the leftover legacy 'unlimited' row (never
-- deleted by that rename) picked up the intended numbers. Confirmed live via
-- a debug function reading subscription_plans with the service role.
--
-- Re-seeding with the real ids, sub-linear vs listing_limit for the same
-- reason as before: real Amazon SP-API rate limits are shared account-wide,
-- so the top tier can't actually sustain "checked every ~1 minute" at a
-- linear scale.

UPDATE public.subscription_plans SET priority_star_cap = 5,  sp_api_calls_per_minute_cap = 10 WHERE id = 'tier_100';
UPDATE public.subscription_plans SET priority_star_cap = 6,  sp_api_calls_per_minute_cap = 12 WHERE id = 'tier_250';
UPDATE public.subscription_plans SET priority_star_cap = 8,  sp_api_calls_per_minute_cap = 16 WHERE id = 'tier_500';
UPDATE public.subscription_plans SET priority_star_cap = 10, sp_api_calls_per_minute_cap = 20 WHERE id = 'tier_1000';
UPDATE public.subscription_plans SET priority_star_cap = 12, sp_api_calls_per_minute_cap = 24 WHERE id = 'tier_2000';
UPDATE public.subscription_plans SET priority_star_cap = 14, sp_api_calls_per_minute_cap = 28 WHERE id = 'tier_3000';
UPDATE public.subscription_plans SET priority_star_cap = 16, sp_api_calls_per_minute_cap = 32 WHERE id = 'tier_5000';
UPDATE public.subscription_plans SET priority_star_cap = 18, sp_api_calls_per_minute_cap = 36 WHERE id = 'tier_10000';
UPDATE public.subscription_plans SET priority_star_cap = 20, sp_api_calls_per_minute_cap = 40 WHERE id = 'tier_20000';
UPDATE public.subscription_plans SET priority_star_cap = 20, sp_api_calls_per_minute_cap = 40 WHERE id = 'tier_50000';

-- Re-run the same conservative backfill for any repricer_settings row still
-- on the blanket default of 10, now that the tier_* rows carry real values
-- (this mostly matters for accounts on tier_100, which stays at 10 anyway).
UPDATE public.repricer_settings rs
SET sp_api_calls_per_minute_cap = sp.sp_api_calls_per_minute_cap
FROM public.user_subscriptions us
JOIN public.subscription_plans sp ON sp.id = us.plan_id
WHERE rs.user_id = us.user_id
  AND rs.sp_api_calls_per_minute_cap = 10;
