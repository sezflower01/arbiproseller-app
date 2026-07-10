
CREATE OR REPLACE FUNCTION public.resolve_business_health_issue(_id uuid, _reason text DEFAULT 'manual')
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.business_health_issues
     SET status = 'resolved', resolved_at = now(), resolved_reason = _reason, updated_at = now()
   WHERE id = _id
     AND (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));
END;
$$;

CREATE OR REPLACE FUNCTION public.ignore_business_health_pattern(_id uuid, _hours int DEFAULT 24)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.business_health_issues
     SET status = 'ignored', ignored_until = now() + (_hours || ' hours')::interval, updated_at = now()
   WHERE id = _id
     AND (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));
END;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_business_health_issue(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ignore_business_health_pattern(uuid, int) TO authenticated;
