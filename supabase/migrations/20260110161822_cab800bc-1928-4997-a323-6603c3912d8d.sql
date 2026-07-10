-- Step 1: Delete duplicate inbound fees, keeping only the earliest record per unique event
-- Identify duplicates by AmazonOrderId (shipment ID) + fee_type + fee_amount
WITH duplicates AS (
  SELECT id,
    ROW_NUMBER() OVER (
      PARTITION BY 
        user_id,
        raw_event->>'AmazonOrderId',
        fee_type,
        fee_amount
      ORDER BY created_at ASC
    ) as rn
  FROM fba_inbound_fees
  WHERE raw_event->>'AmazonOrderId' IS NOT NULL
)
DELETE FROM fba_inbound_fees
WHERE id IN (SELECT id FROM duplicates WHERE rn > 1);

-- Step 2: Drop the old unique constraint if it exists
DROP INDEX IF EXISTS fba_inbound_fees_unique_event;
DROP INDEX IF EXISTS fba_inbound_fees_user_fee_posted_idx;

-- Step 3: Create a new unique constraint that includes shipment_id
-- This prevents the same fee event from being inserted twice regardless of posted_date
CREATE UNIQUE INDEX fba_inbound_fees_unique_event 
ON fba_inbound_fees (user_id, fee_type, fee_amount, COALESCE(shipment_id, ''), posted_date);

-- Step 4: Also update shipment_id from raw_event where it's NULL
UPDATE fba_inbound_fees
SET shipment_id = raw_event->>'AmazonOrderId'
WHERE shipment_id IS NULL 
  AND raw_event->>'AmazonOrderId' IS NOT NULL;