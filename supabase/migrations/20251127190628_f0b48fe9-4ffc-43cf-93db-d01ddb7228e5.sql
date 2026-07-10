
-- Enable replica identity FULL for fnsku_map to support realtime updates
ALTER TABLE public.fnsku_map REPLICA IDENTITY FULL;

-- Add fnsku_map to the realtime publication so clients can subscribe to changes
ALTER PUBLICATION supabase_realtime ADD TABLE public.fnsku_map;
