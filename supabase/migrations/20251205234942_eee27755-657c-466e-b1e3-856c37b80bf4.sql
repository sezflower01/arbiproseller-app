-- Create table to track P&L sync progress
CREATE TABLE public.pl_sync_progress (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  current_chunk INTEGER DEFAULT 0,
  total_chunks INTEGER DEFAULT 0,
  message TEXT,
  summary JSONB,
  cogs NUMERIC DEFAULT 0,
  net_profit NUMERIC DEFAULT 0,
  error TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.pl_sync_progress ENABLE ROW LEVEL SECURITY;

-- Create policies
CREATE POLICY "Users can view their own progress" 
ON public.pl_sync_progress 
FOR SELECT 
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own progress" 
ON public.pl_sync_progress 
FOR INSERT 
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own progress" 
ON public.pl_sync_progress 
FOR UPDATE 
USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own progress" 
ON public.pl_sync_progress 
FOR DELETE 
USING (auth.uid() = user_id);

-- Create index for user lookups
CREATE INDEX idx_pl_sync_progress_user_id ON public.pl_sync_progress(user_id);

-- Enable realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.pl_sync_progress;