-- Add source_type column to asin_items to track scraping method
ALTER TABLE asin_items 
ADD COLUMN IF NOT EXISTS source_type text DEFAULT 'api';

-- Add index for better query performance
CREATE INDEX IF NOT EXISTS idx_asin_items_source_type 
ON asin_items(source_type);

-- Add comment
COMMENT ON COLUMN asin_items.source_type IS 'Source of the data: api (Google Custom Search API) or selenium (direct scraping)';