
-- Add trial_end_date column to user_subscriptions
ALTER TABLE public.user_subscriptions
ADD COLUMN IF NOT EXISTS trial_end_date TIMESTAMPTZ;

-- Create function to auto-create trial subscription on profile creation
CREATE OR REPLACE FUNCTION public.fn_auto_create_trial_subscription()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- Only create if no subscription exists yet
  INSERT INTO public.user_subscriptions (user_id, plan_id, billing_interval, status, trial_end_date, started_at)
  VALUES (NEW.id, 'tier_100', 'monthly', 'trial', now() + interval '60 days', now())
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

-- Create trigger on profiles table (fires after profile insert)
DROP TRIGGER IF EXISTS trg_auto_create_trial_subscription ON public.profiles;
CREATE TRIGGER trg_auto_create_trial_subscription
  AFTER INSERT ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_auto_create_trial_subscription();
