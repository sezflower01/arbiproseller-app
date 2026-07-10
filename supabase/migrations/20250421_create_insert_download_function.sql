
-- Function to insert download records that bypasses RLS
CREATE OR REPLACE FUNCTION public.insert_download_record(
  ip_address TEXT,
  country TEXT,
  region TEXT,
  city TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  user_agent TEXT,
  file_type TEXT,
  downloaded_at TIMESTAMPTZ
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.downloads (
    ip_address,
    country,
    region,
    city,
    latitude,
    longitude,
    user_agent,
    file_type,
    downloaded_at
  ) VALUES (
    ip_address,
    country,
    region,
    city,
    latitude,
    longitude,
    user_agent,
    file_type,
    downloaded_at
  );
  
  RETURN TRUE;
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'Error in insert_download_record: %', SQLERRM;
    RETURN FALSE;
END;
$$;

-- Grant execute permission to anonymous users
GRANT EXECUTE ON FUNCTION public.insert_download_record TO anon;
GRANT EXECUTE ON FUNCTION public.insert_download_record TO authenticated;
