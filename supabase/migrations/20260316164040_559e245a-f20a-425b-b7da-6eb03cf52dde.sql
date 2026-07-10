-- Enable sequential sweep and set batch size for user
-- This is a data update, using a function to bypass RLS
CREATE OR REPLACE FUNCTION public.enable_sweep_for_user(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  UPDATE public.repricer_settings
  SET sequential_sweep_enabled = true,
      sequential_sweep_batch_size = 50
  WHERE user_id = p_user_id;
END;
$$;

SELECT public.enable_sweep_for_user('020dd71f-78ce-4bc2-9117-dc997c533ab9');

DROP FUNCTION public.enable_sweep_for_user(uuid);