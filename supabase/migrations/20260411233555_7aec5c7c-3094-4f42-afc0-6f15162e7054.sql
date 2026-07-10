ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS auto_raise_roi_floor_us boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_raise_roi_floor_ca boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_raise_roi_floor_mx boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_raise_roi_floor_br boolean NOT NULL DEFAULT false;