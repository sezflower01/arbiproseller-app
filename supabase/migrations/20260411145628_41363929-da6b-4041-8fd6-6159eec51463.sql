CREATE OR REPLACE FUNCTION public.nextval_generated_invoice_seq()
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT nextval('generated_invoice_seq');
$$;