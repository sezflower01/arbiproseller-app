ALTER TABLE public.repricer_setting_changes 
ADD COLUMN IF NOT EXISTS device_info text DEFAULT NULL;