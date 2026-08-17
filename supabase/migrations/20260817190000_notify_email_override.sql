-- Per-user notification address for new-listing alerts.
--
-- NULL means "use the account email", which is what every existing user gets
-- and why no backfill is needed.
--
-- Stored ONCE here rather than updated across seller_watchlist.notify_email.
-- That column is denormalised onto every watch row -- 400+ for a real user --
-- so changing the address by rewriting rows would mean a bulk update on every
-- edit AND leaving create-seller-watch/bulk-create-seller-watches still
-- stamping the account email onto anything created afterwards. Two sources of
-- truth immediately. Resolving at SEND time instead keeps one.
ALTER TABLE public.auto_source_config
  ADD COLUMN IF NOT EXISTS notify_email text;

-- Format guard at the last line of defence. The UI validates too, but this is
-- what guarantees a malformed address can never reach the sender -- the value
-- is read by a cron worker with a service-role key, long after any client-side
-- check has stopped being in the picture.
--
-- Deliberately permissive: one @, no whitespace, a dot in the domain. Stricter
-- regexes reject valid addresses (plus-tags, long TLDs, unusual local parts)
-- and this is a typo guard, not an RFC 5322 implementation.
ALTER TABLE public.auto_source_config
  DROP CONSTRAINT IF EXISTS auto_source_config_notify_email_chk;
ALTER TABLE public.auto_source_config
  ADD CONSTRAINT auto_source_config_notify_email_chk
  CHECK (
    notify_email IS NULL
    OR notify_email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  );

COMMENT ON COLUMN public.auto_source_config.notify_email IS
  'Where new-listing alerts go. NULL = the account login email. NOT verified -- the user is told so in the UI, matching the deliberate removal of the seller-watch confirmation step in 20260815230000.';
