-- Increase SP-API cap from 10 to 20 for the active user
CREATE OR REPLACE FUNCTION public.tmp_set_sp_api_cap()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE repricer_settings SET sp_api_calls_per_minute_cap = 20 WHERE user_id = '020dd71f-78ce-4bc2-9117-dc997c533ab9';
END;
$$;

SELECT public.tmp_set_sp_api_cap();

DROP FUNCTION public.tmp_set_sp_api_cap();