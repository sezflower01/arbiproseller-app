-- Step 1: Delete duplicates first, keeping only the NEWEST one per unique combination
-- Using a CTE to identify duplicates
WITH duplicates AS (
  SELECT id,
    ROW_NUMBER() OVER (
      PARTITION BY user_id, fee_type, fee_amount, posted_date, COALESCE(shipment_day, posted_date::date)
      ORDER BY created_at DESC
    ) AS rn
  FROM fba_inbound_fees
)
DELETE FROM fba_inbound_fees
WHERE id IN (
  SELECT id FROM duplicates WHERE rn > 1
);

-- Step 2: Now create the unique index to prevent future duplicates
CREATE UNIQUE INDEX fba_inbound_fees_unique_fee 
ON fba_inbound_fees (
  user_id, 
  fee_type, 
  fee_amount, 
  posted_date, 
  COALESCE(shipment_day, posted_date::date)
);