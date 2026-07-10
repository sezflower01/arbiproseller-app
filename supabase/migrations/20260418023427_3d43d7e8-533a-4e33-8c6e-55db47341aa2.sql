UPDATE public.store_scan_runs
SET status = 'done',
    completed_at = COALESCE(completed_at, now()),
    error_message = COALESCE(error_message, 'Completed via legacy single-shot pipeline before chunked rollout — only ' || COALESCE(products_extracted, 0) + COALESCE(products_unmatched, 0) + COALESCE(products_failed, 0) || ' of ' || COALESCE(products_found, 0) || ' processed.')
WHERE id = '0b46ebfd-7eaa-4f2b-9e65-86c390d1ddc3'
  AND status NOT IN ('done', 'error');