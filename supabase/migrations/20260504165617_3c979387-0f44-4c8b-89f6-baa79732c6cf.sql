UPDATE inventory SET fnsku='X0053CP48J' WHERE asin='B0FLQVBZWX' AND sku='LYX-VUX-H93G' AND fnsku IS NULL;
INSERT INTO fnsku_map (seller_id, marketplace_id, asin, seller_sku, fnsku, condition)
VALUES ('unknown','ATVPDKIKX0DER','B0FLQVBZWX','LYX-VUX-H93G','X0053CP48J','NEW')
ON CONFLICT DO NOTHING;