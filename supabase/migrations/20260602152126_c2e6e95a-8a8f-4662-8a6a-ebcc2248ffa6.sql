-- Lightweight admin-only RPC to replace the 39k-call/day unbounded scan
-- of repricer_price_actions.user_id from AdminErrorNotification.
-- Returns a single integer; uses the existing idx_rpa_created_at_action index.
CREATE OR REPLACE FUNCTION public.count_active_repricer_users_1h()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COUNT(DISTINCT user_id)::int
  FROM public.repricer_price_actions
  WHERE created_at >= now() - interval '1 hour'
    AND public.has_role(auth.uid(), 'admin');
$$;

REVOKE ALL ON FUNCTION public.count_active_repricer_users_1h() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.count_active_repricer_users_1h() TO authenticated;