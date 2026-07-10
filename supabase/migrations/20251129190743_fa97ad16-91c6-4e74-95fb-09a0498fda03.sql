-- Add source column to inventory table to distinguish manual vs synced items
ALTER TABLE inventory 
ADD COLUMN source text DEFAULT 'manual' CHECK (source IN ('manual', 'amazon_sync'));

-- Update existing records to have a source value
UPDATE inventory 
SET source = 'manual' 
WHERE source IS NULL;