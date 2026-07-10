-- Add expense name column to expenses table
ALTER TABLE public.expenses 
ADD COLUMN name text;