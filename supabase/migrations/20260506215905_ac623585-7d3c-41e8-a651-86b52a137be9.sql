DROP INDEX IF EXISTS public.fnsku_map_unique_idx;

INSERT INTO public.fnsku_map (seller_id, marketplace_id, asin, seller_sku, fnsku, condition)
VALUES ('A1B0EBOAJDDILW','ATVPDKIKX0DER','B0CCSQ62KN','amzn.gr.1066502134-gHXybu7rkamTXRR_BE-VG','X004VXLY99','USED - VERY GOOD')
ON CONFLICT (seller_id, marketplace_id, asin, fnsku)
DO UPDATE SET seller_sku = EXCLUDED.seller_sku, condition = EXCLUDED.condition;