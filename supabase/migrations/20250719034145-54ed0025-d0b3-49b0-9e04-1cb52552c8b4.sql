-- Create error_logs table for application error tracking
CREATE TABLE public.error_logs (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
    message TEXT,
    stacktrace TEXT,
    module TEXT,
    user_id TEXT,
    app_version TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable Row Level Security
ALTER TABLE public.error_logs ENABLE ROW LEVEL SECURITY;

-- Allow anyone to insert error logs (for error reporting)
CREATE POLICY "Anyone can insert error logs" 
ON public.error_logs 
FOR INSERT 
WITH CHECK (true);

-- Only authenticated users can view error logs
CREATE POLICY "Authenticated users can view error logs" 
ON public.error_logs 
FOR SELECT 
USING (auth.role() = 'authenticated');

-- Create index for better performance on timestamp queries
CREATE INDEX idx_error_logs_timestamp ON public.error_logs(timestamp DESC);
CREATE INDEX idx_error_logs_module ON public.error_logs(module);
CREATE INDEX idx_error_logs_user_id ON public.error_logs(user_id);