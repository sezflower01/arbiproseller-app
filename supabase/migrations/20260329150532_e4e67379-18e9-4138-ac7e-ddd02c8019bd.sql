ALTER TABLE public.repricer_assignments ADD COLUMN IF NOT EXISTS item_condition text DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_repricer_assignments_item_condition ON public.repricer_assignments(item_condition) WHERE item_condition IS NOT NULL;
UPDATE public.repricer_assignments SET item_condition = 'Used' WHERE item_condition IS NULL AND sku LIKE 'amzn.gr.%';