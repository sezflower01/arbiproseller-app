-- Clear recent inbound fees to re-sync with corrected Central Time timezone
DELETE FROM fba_inbound_fees WHERE posted_date >= '2026-01-08';