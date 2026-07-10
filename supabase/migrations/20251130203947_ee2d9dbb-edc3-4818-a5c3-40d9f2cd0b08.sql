
-- Add fees_json column to inventory table to store Amazon fees for ROI calculation
ALTER TABLE inventory 
ADD COLUMN IF NOT EXISTS fees_json jsonb;

-- Add comment explaining the column
COMMENT ON COLUMN inventory.fees_json IS 'Stores Amazon fees (referralFee, fbaFee, variableClosingFee, otherFees) from SP-API for ROI calculation';
