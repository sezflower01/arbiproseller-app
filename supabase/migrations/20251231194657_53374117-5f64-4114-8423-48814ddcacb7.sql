-- Add end_date column to expenses table
ALTER TABLE public.expenses 
ADD COLUMN end_date date;