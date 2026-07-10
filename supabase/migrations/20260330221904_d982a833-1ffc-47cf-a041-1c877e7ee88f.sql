
-- Subscription plans reference
CREATE TABLE public.subscription_plans (
  id text PRIMARY KEY,
  name text NOT NULL,
  listing_limit integer NOT NULL,
  monthly_price numeric(8,2) NOT NULL,
  annual_price numeric(8,2) NOT NULL,
  sort_order integer NOT NULL DEFAULT 0
);

INSERT INTO public.subscription_plans (id, name, listing_limit, monthly_price, annual_price, sort_order) VALUES
  ('starter',  'Starter',   1000, 29, 24, 1),
  ('growth',   'Growth',    2000, 49, 41, 2),
  ('pro',      'Pro',       3000, 69, 58, 3),
  ('advanced', 'Advanced',  4000, 89, 74, 4),
  ('unlimited','Unlimited', 999999, 0, 0, 5);

ALTER TABLE public.subscription_plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read plans" ON public.subscription_plans FOR SELECT USING (true);

-- User subscriptions
CREATE TABLE public.user_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plan_id text NOT NULL REFERENCES public.subscription_plans(id) DEFAULT 'starter',
  billing_interval text NOT NULL DEFAULT 'monthly',
  status text NOT NULL DEFAULT 'active',
  started_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id)
);

ALTER TABLE public.user_subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can read own subscription" ON public.user_subscriptions FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Admins can manage all subscriptions" ON public.user_subscriptions FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER update_user_subscriptions_updated_at
  BEFORE UPDATE ON public.user_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Admin subscription override
CREATE TABLE public.admin_subscription_override (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  override_enabled boolean NOT NULL DEFAULT false,
  override_plan_id text REFERENCES public.subscription_plans(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id)
);

ALTER TABLE public.admin_subscription_override ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins can manage overrides" ON public.admin_subscription_override FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER update_admin_override_updated_at
  BEFORE UPDATE ON public.admin_subscription_override
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Seed admin with Advanced plan + override
INSERT INTO public.user_subscriptions (user_id, plan_id, billing_interval, status)
VALUES ('020dd71f-78ce-4bc2-9117-dc997c533ab9', 'advanced', 'annual', 'active');

INSERT INTO public.admin_subscription_override (user_id, override_enabled, override_plan_id)
VALUES ('020dd71f-78ce-4bc2-9117-dc997c533ab9', true, 'advanced');
