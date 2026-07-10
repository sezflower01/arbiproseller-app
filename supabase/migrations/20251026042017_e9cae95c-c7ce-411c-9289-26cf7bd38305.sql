-- Helper function to atomically deduct credits
CREATE OR REPLACE FUNCTION public.deduct_credits(user_id UUID, amount INTEGER)
RETURNS VOID AS $$
BEGIN
  UPDATE public.profiles
  SET credits = credits - amount
  WHERE id = user_id AND credits >= amount;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Insufficient credits';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;