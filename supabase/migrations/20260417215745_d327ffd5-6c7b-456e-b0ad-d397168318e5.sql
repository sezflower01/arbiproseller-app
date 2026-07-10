-- Backfill: link historical admin Target.com scan runs to the existing "Books" curated category
-- so the user-facing Store Scan page can show the matches that already exist.
UPDATE store_scan_runs r
SET category_id = '40cc635e-fb51-4bdb-a099-84a9e3b01b90'
WHERE r.category_id IS NULL
  AND r.user_id = '020dd71f-78ce-4bc2-9117-dc997c533ab9'
  AND EXISTS (
    SELECT 1 FROM store_scan_items i
    WHERE i.run_id = r.id
      AND i.matched_asin IS NOT NULL
      AND i.source_url ILIKE '%target.com%'
  );