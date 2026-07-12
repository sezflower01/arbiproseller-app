ALTER FUNCTION public.classify_health_display_category(text, text) SET search_path = public;
ALTER FUNCTION public.classify_health_stuck_reason(text, text) SET search_path = public;
ALTER FUNCTION public.compute_next_retry_at(integer) SET search_path = public;
ALTER FUNCTION public.derive_health_severity(text, integer, text, boolean) SET search_path = public;
ALTER FUNCTION public.is_active_created_listing(text) SET search_path = public;