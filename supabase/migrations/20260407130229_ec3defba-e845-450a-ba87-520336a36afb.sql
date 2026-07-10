UPDATE public.inventory
SET listing_status = 'MISMATCH',
    last_inventory_sync_at = NULL,
    source = 'manual'
WHERE user_id = '020dd71f-78ce-4bc2-9117-dc997c533ab9'
  AND asin = 'B079STG3DR'
  AND sku = '1065667431';