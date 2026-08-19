-- Make the kind CHECK widening name-independent, and prove it took effect.
--
-- 20260819240000 assumed the inline CHECK was named source_excluded_terms_kind_check,
-- which is Postgres's default for a column constraint -- but only a default. If
-- the live constraint carried any other name, that migration's
-- `DROP CONSTRAINT IF EXISTS` was a silent no-op and its `ADD CONSTRAINT`
-- created a SECOND constraint beside the original. Both would then apply, the
-- old one still rejecting 'title_keyword', and the migration would have
-- reported success. There is no Docker on the dev machine, so the schema could
-- not be dumped to check -- hence this, which does not need to know the name.
--
-- Drops EVERY check constraint on the table that constrains `kind`, adds the
-- canonical one, then asserts the result rather than trusting it.

DO $$
DECLARE
  c record;
  n int;
BEGIN
  FOR c IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.source_excluded_terms'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%kind%'
  LOOP
    EXECUTE format('ALTER TABLE public.source_excluded_terms DROP CONSTRAINT %I', c.conname);
    RAISE NOTICE 'dropped kind check constraint %', c.conname;
  END LOOP;

  ALTER TABLE public.source_excluded_terms
    ADD CONSTRAINT source_excluded_terms_kind_check
    CHECK (kind IN ('category', 'brand', 'title_keyword'));

  -- Assert: exactly one kind constraint, and it admits title_keyword.
  SELECT count(*) INTO n
  FROM pg_constraint
  WHERE conrelid = 'public.source_excluded_terms'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%kind%';
  IF n <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 kind check constraint, found %', n;
  END IF;

  SELECT count(*) INTO n
  FROM pg_constraint
  WHERE conrelid = 'public.source_excluded_terms'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%title_keyword%';
  IF n <> 1 THEN
    RAISE EXCEPTION 'kind check constraint does not admit title_keyword';
  END IF;
END $$;

-- Belt and braces: an actual round-trip insert of the new kind, rolled back.
-- The constraint definition reading correctly and the value being ACCEPTED are
-- two different claims, and only this one tests the second.
DO $$
DECLARE
  uid uuid;
BEGIN
  SELECT id INTO uid FROM auth.users LIMIT 1;
  IF uid IS NULL THEN
    RAISE NOTICE 'no users yet -- skipping the round-trip insert check';
    RETURN;
  END IF;
  INSERT INTO public.source_excluded_terms (user_id, kind, value, label)
  VALUES (uid, 'title_keyword', '__migration_probe__', '__migration_probe__');
  DELETE FROM public.source_excluded_terms
  WHERE user_id = uid AND kind = 'title_keyword' AND value = '__migration_probe__';
  RAISE NOTICE 'title_keyword insert accepted';
END $$;
