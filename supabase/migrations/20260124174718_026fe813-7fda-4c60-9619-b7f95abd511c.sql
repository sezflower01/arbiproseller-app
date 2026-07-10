-- Add MX marketplace authorization (same seller, same refresh token, different marketplace)
-- This enables proper Listings API calls for MX orders when Orders API returns $0

INSERT INTO public.seller_authorizations (
  user_id,
  seller_id,
  selling_partner_id,
  marketplace_id,
  refresh_token,
  created_at,
  updated_at
)
SELECT 
  user_id,
  seller_id,
  selling_partner_id,
  'A1AM78C64UM0Y8' AS marketplace_id,  -- Mexico marketplace
  refresh_token,
  now(),
  now()
FROM public.seller_authorizations
WHERE marketplace_id = 'ATVPDKIKX0DER'  -- Copy from US authorization
  AND NOT EXISTS (
    SELECT 1 FROM public.seller_authorizations mx
    WHERE mx.user_id = seller_authorizations.user_id
      AND mx.marketplace_id = 'A1AM78C64UM0Y8'
  );

-- Also add CA marketplace for completeness (same pattern)
INSERT INTO public.seller_authorizations (
  user_id,
  seller_id,
  selling_partner_id,
  marketplace_id,
  refresh_token,
  created_at,
  updated_at
)
SELECT 
  user_id,
  seller_id,
  selling_partner_id,
  'A2EUQ1WTGCTBG2' AS marketplace_id,  -- Canada marketplace
  refresh_token,
  now(),
  now()
FROM public.seller_authorizations
WHERE marketplace_id = 'ATVPDKIKX0DER'
  AND NOT EXISTS (
    SELECT 1 FROM public.seller_authorizations ca
    WHERE ca.user_id = seller_authorizations.user_id
      AND ca.marketplace_id = 'A2EUQ1WTGCTBG2'
  );