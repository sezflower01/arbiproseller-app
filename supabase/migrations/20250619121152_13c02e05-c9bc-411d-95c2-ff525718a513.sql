
-- Drop the trigger that's causing the error (using correct case-sensitive table name)
DROP TRIGGER IF EXISTS hash_password_trigger ON "RegisterUser";

-- Drop the function that references the removed createpassword column
DROP FUNCTION IF EXISTS public.hash_password();
