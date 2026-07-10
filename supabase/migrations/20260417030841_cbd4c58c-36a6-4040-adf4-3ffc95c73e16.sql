WITH expanded AS (
  SELECT cl.user_id, sl.value->>'link' AS raw_link
  FROM public.created_listings cl,
       LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(cl.supplier_links)='array' THEN cl.supplier_links ELSE '[]'::jsonb END) AS sl
  WHERE cl.user_id = '020dd71f-78ce-4bc2-9117-dc997c533ab9'
),
cleaned AS (
  SELECT user_id,
         lower(regexp_replace(regexp_replace(regexp_replace(trim(both '#' from coalesce(raw_link,'')), '^https?://', ''), '^www\.', ''), '/.*$', '')) AS domain
  FROM expanded
  WHERE raw_link IS NOT NULL AND raw_link <> ''
),
valid AS (
  SELECT DISTINCT user_id, domain
  FROM cleaned
  WHERE domain LIKE '%.%' AND domain NOT LIKE '% %' AND length(domain) BETWEEN 4 AND 100
    AND domain !~ '^[0-9.]+$'
    AND domain NOT IN ('facebook.com','instagram.com','tiktok.com','twitter.com','x.com','pinterest.com','youtube.com','youtu.be','reddit.com','linkedin.com','snapchat.com','threads.net','amazon.com','amazon.ca','amazon.co.uk','amazon.de','amazon.fr','amazon.it','amazon.es','amazon.com.mx','amazon.com.br','ebay.com','aliexpress.com','alibaba.com','etsy.com','mercadolibre.com','wish.com','temu.com','shein.com','google.com','google.co.uk','bing.com','duckduckgo.com','paypal.com','stripe.com','venmo.com','localhost','example.com','test.com','none.com','n-a.com','n/a','a.co','goo.gl','bit.ly','t.co')
    AND domain NOT LIKE '%.amazon.%' AND domain NOT LIKE 'amzn.%'
    AND domain NOT LIKE '%.ebay.%' AND domain NOT LIKE '%.google.%'
    AND domain NOT LIKE 'l.facebook.%' AND domain NOT LIKE 'm.facebook.%'
    AND domain NOT LIKE 'tinyurl.%'
)
INSERT INTO public.suppliers (user_id, domain, supplier_type, trust_level, source_origin, supports_scraping)
SELECT user_id, domain, 'retail', 'trusted', 'curated', true
FROM valid
ON CONFLICT (user_id, domain) DO NOTHING;