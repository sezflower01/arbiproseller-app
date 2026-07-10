-- Add Brazil (BR) marketplace authorization (without ON CONFLICT since no unique constraint exists)
INSERT INTO seller_authorizations (user_id, seller_id, selling_partner_id, marketplace_id, refresh_token)
SELECT 
  user_id, 
  seller_id, 
  selling_partner_id, 
  'A2Q3Y263D00KWC' as marketplace_id,
  refresh_token
FROM seller_authorizations
WHERE marketplace_id = 'ATVPDKIKX0DER'
AND NOT EXISTS (
  SELECT 1 FROM seller_authorizations sa2 
  WHERE sa2.user_id = seller_authorizations.user_id 
  AND sa2.marketplace_id = 'A2Q3Y263D00KWC'
);