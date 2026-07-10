
-- Create repricer_monitor_checks table for daily checklist persistence
CREATE TABLE public.repricer_monitor_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  check_date date NOT NULL DEFAULT CURRENT_DATE,
  step_key text NOT NULL,
  is_checked boolean NOT NULL DEFAULT false,
  checked_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, check_date, step_key)
);

ALTER TABLE public.repricer_monitor_checks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Monitor or admin can manage their checks"
ON public.repricer_monitor_checks
FOR ALL
USING (auth.uid() = user_id AND (has_role(auth.uid(), 'monitor') OR has_role(auth.uid(), 'admin')))
WITH CHECK (auth.uid() = user_id AND (has_role(auth.uid(), 'monitor') OR has_role(auth.uid(), 'admin')));

-- Create repricer_incidents table for escalation
CREATE TABLE public.repricer_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  severity text NOT NULL DEFAULT 'medium',
  category text NOT NULL,
  notes text,
  summary_snapshot jsonb,
  status text NOT NULL DEFAULT 'open',
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.repricer_incidents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Monitor or admin can manage own incidents"
ON public.repricer_incidents
FOR ALL
USING (auth.uid() = user_id AND (has_role(auth.uid(), 'monitor') OR has_role(auth.uid(), 'admin')))
WITH CHECK (auth.uid() = user_id AND (has_role(auth.uid(), 'monitor') OR has_role(auth.uid(), 'admin')));

CREATE POLICY "Admins can view all incidents"
ON public.repricer_incidents
FOR SELECT
USING (has_role(auth.uid(), 'admin'));

-- Allow monitor role to READ repricer tables (read-only)
CREATE POLICY "Monitors can view feed submissions"
ON public.repricer_feed_submissions
FOR SELECT
USING (has_role(auth.uid(), 'monitor'));

CREATE POLICY "Monitors can view price actions"
ON public.repricer_price_actions
FOR SELECT
USING (has_role(auth.uid(), 'monitor'));

CREATE POLICY "Monitors can view assignments"
ON public.repricer_assignments
FOR SELECT
USING (has_role(auth.uid(), 'monitor'));

CREATE POLICY "Monitors can view repricer settings"
ON public.repricer_settings
FOR SELECT
USING (has_role(auth.uid(), 'monitor'));
