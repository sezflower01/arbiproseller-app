
-- Step 1: Delete duplicate assignment rows, keeping the most recently updated per ASIN+marketplace+user
DELETE FROM public.repricer_assignments
WHERE id IN (
  SELECT id FROM (
    SELECT id,
      ROW_NUMBER() OVER (PARTITION BY asin, marketplace, user_id ORDER BY updated_at DESC NULLS LAST, created_at DESC) as rn
    FROM public.repricer_assignments
  ) ranked
  WHERE rn > 1
);

-- Step 2: Add unique constraint to prevent future duplicates
ALTER TABLE public.repricer_assignments
ADD CONSTRAINT uq_assignment_asin_marketplace_user UNIQUE (asin, marketplace, user_id);
