DELETE FROM public.store_scan_ai_verifications
WHERE verification_version < 11
  AND verdict IN ('likely_match', 'review_needed');