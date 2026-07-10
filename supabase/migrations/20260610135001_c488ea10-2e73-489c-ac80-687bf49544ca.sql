
-- 1. Add is_default flag to repricer_rules
ALTER TABLE public.repricer_rules
  ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false;

-- 2. Partial unique index: at most one default per user
CREATE UNIQUE INDEX IF NOT EXISTS repricer_rules_one_default_per_user
  ON public.repricer_rules (user_id)
  WHERE is_default = true;

-- 3. Trigger: when a rule is marked default, unset any other default for the same user
CREATE OR REPLACE FUNCTION public.enforce_single_default_repricer_rule()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.is_default IS TRUE THEN
    UPDATE public.repricer_rules
       SET is_default = false
     WHERE user_id = NEW.user_id
       AND id <> NEW.id
       AND is_default = true;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_single_default_repricer_rule ON public.repricer_rules;
CREATE TRIGGER trg_single_default_repricer_rule
  BEFORE INSERT OR UPDATE OF is_default ON public.repricer_rules
  FOR EACH ROW
  WHEN (NEW.is_default = true)
  EXECUTE FUNCTION public.enforce_single_default_repricer_rule();

-- 4. Backfill: for every user, pick a default rule
--    Priority: existing user_settings.auto_assign_rule_id → MOMENTUM_BUILDER → BALANCED_PRO → any non-aggressive
WITH chosen AS (
  SELECT DISTINCT ON (r.user_id)
         r.user_id,
         r.id
    FROM public.repricer_rules r
    LEFT JOIN public.user_settings us ON us.user_id = r.user_id
   ORDER BY r.user_id,
            (us.auto_assign_rule_id = r.id) DESC NULLS LAST,
            (r.smart_profile = 'MOMENTUM_BUILDER') DESC,
            (r.smart_profile = 'BALANCED_PRO') DESC,
            (r.smart_profile NOT IN ('VELOCITY_DOMINATOR','LIQUIDATION')) DESC,
            r.created_at ASC
)
UPDATE public.repricer_rules r
   SET is_default = true
  FROM chosen c
 WHERE r.id = c.id
   AND r.is_default = false;
