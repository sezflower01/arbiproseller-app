
-- 1. repricer_asin_locks: restrict ALL to service_role
DROP POLICY IF EXISTS "Service role manages locks" ON public.repricer_asin_locks;
CREATE POLICY "Service role manages locks" ON public.repricer_asin_locks
  AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 2. repricer_idempotency: restrict ALL to service_role
DROP POLICY IF EXISTS "Service role manages idempotency" ON public.repricer_idempotency;
CREATE POLICY "Service role manages idempotency" ON public.repricer_idempotency
  AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 3. rainforest_daily_usage: restrict ALL to service_role
DROP POLICY IF EXISTS "Service role full access" ON public.rainforest_daily_usage;
CREATE POLICY "Service role full access" ON public.rainforest_daily_usage
  AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 4. RegisterUser: remove tautological UPDATE policy; restrict to service_role
DROP POLICY IF EXISTS "Users can update their username, licensekey and createpassword" ON public."RegisterUser";
CREATE POLICY "Service role manages RegisterUser" ON public."RegisterUser"
  AS PERMISSIVE FOR UPDATE TO service_role USING (true) WITH CHECK (true);

-- 5. scrape_cache/logs/state: remove broad authenticated SELECT; keep admin/service_role
DROP POLICY IF EXISTS "Allow authenticated users to read cache" ON public.scrape_cache;
DROP POLICY IF EXISTS "Allow authenticated users to read logs" ON public.scrape_logs;
DROP POLICY IF EXISTS "Allow authenticated users to read state" ON public.scrape_state;
-- Replace the public-role auth.role() ALL policies with service_role-targeted policies
DROP POLICY IF EXISTS "Service role can manage logs" ON public.scrape_logs;
DROP POLICY IF EXISTS "Service role can manage state" ON public.scrape_state;

-- 6. store_scan_ai_verifications: restrict reads to admin/service_role only (no user_id column)
DROP POLICY IF EXISTS "ai_verif_read_all_authenticated" ON public.store_scan_ai_verifications;
CREATE POLICY "ai_verif_read_admins" ON public.store_scan_ai_verifications
  AS PERMISSIVE FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::app_role));

-- 7. keepa_simple_products: restrict writes to service_role; keep authenticated reads
DROP POLICY IF EXISTS "Authenticated users can insert keepa_simple_products" ON public.keepa_simple_products;
DROP POLICY IF EXISTS "Authenticated users can update keepa_simple_products" ON public.keepa_simple_products;
DROP POLICY IF EXISTS "Authenticated users can delete keepa_simple_products" ON public.keepa_simple_products;

-- 8. buy_box_cache: restrict writes to service_role
DROP POLICY IF EXISTS "Authenticated users can insert buy box cache" ON public.buy_box_cache;
DROP POLICY IF EXISTS "Authenticated users can update buy box cache" ON public.buy_box_cache;
CREATE POLICY "Service role manages buy_box_cache" ON public.buy_box_cache
  AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 9. subscription_plans: restrict reads to authenticated
DROP POLICY IF EXISTS "Anyone can read plans" ON public.subscription_plans;
CREATE POLICY "Authenticated users can read plans" ON public.subscription_plans
  AS PERMISSIVE FOR SELECT TO authenticated USING (true);

-- 10. admin_profiles: restrict SELECT to admins only
DROP POLICY IF EXISTS "Anyone can view admin profiles" ON public.admin_profiles;
CREATE POLICY "Admins can view admin profiles" ON public.admin_profiles
  AS PERMISSIVE FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::app_role));

-- 11. Storage 'access' bucket: require auth + folder ownership
DROP POLICY IF EXISTS "Give public access to files in access bucket" ON storage.objects;
CREATE POLICY "Users can read own files in access bucket" ON storage.objects
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (
    bucket_id = 'access'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
