# verify_jwt hardening — cron rewrite

This SQL must be executed in the **Supabase SQL Editor**. It uses the supported
`cron.alter_job(...)` API because dashboard roles cannot directly update
`cron.job`.

## What it does

1. Confirms `INTERNAL_SYNC_SECRET` is in the vault; aborts if not.
2. For every scheduled job that invokes one of the 16 hardened edge functions
   (`repricer-*`, `enforce-subscription`, `auto-inventory-sync`,
   `backfill-my-price-cache`, `backfill-order-snapshots`,
   `smart-engine-outcome-snapshot`, `smart-engine-auto-review`):
   - Replaces the `headers := '{...}'::jsonb` literal with a SELECT that reads
     the secret from `vault.decrypted_secrets` at each execution
   - Drops the public anon-key Bearer that was previously being used
3. Idempotent: jobs already containing `x-internal-secret` are skipped.
4. Only rewrites the direct-cron jobs (~8). Fanout-invoked functions like
   `repricer-batch-update` are called by other edge functions using their
   service-role client, which already satisfies the guard.

## How to run

1. Open https://supabase.com/dashboard/project/mstibdszibcheodvnprm/sql/new
2. Paste the block below.
3. Click **Run**. Watch the `NOTICE` output for `OK <jobname>` lines.
4. Verify with the check query at the bottom of this file.

## Rewrite SQL

```sql
DO $$
DECLARE
  job_rec RECORD;
  new_command TEXT;
  rewritten_count INT := 0;
  target_functions TEXT[] := ARRAY[
    'repricer-auto-turbo','repricer-batch-update','repricer-cleanup',
    'repricer-cron-trigger','repricer-evaluate','repricer-priority-cron',
    'repricer-reconcile','repricer-scheduler','repricer-sequential-sweep',
    'repricer-unified-dispatch','enforce-subscription','auto-inventory-sync',
    'backfill-my-price-cache','backfill-order-snapshots',
    'smart-engine-outcome-snapshot','smart-engine-auto-review'
  ];
  match_pattern TEXT;
  header_expr TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM vault.decrypted_secrets WHERE name = 'INTERNAL_SYNC_SECRET'
  ) THEN
    RAISE EXCEPTION 'INTERNAL_SYNC_SECRET not present in vault — aborting';
  END IF;

  match_pattern := '(' || array_to_string(target_functions, '|') || ')';

  header_expr := '(SELECT jsonb_build_object('
              || '''Content-Type'',''application/json'','
              || '''x-internal-secret'', decrypted_secret::text)'
              || ' FROM vault.decrypted_secrets'
              || ' WHERE name=''INTERNAL_SYNC_SECRET'' LIMIT 1)';

  FOR job_rec IN
    SELECT jobid, jobname, command
      FROM cron.job
      WHERE command ~ ('/functions/v1/' || match_pattern || '[^a-zA-Z0-9_-]')
  LOOP
    IF job_rec.command LIKE '%x-internal-secret%' THEN
      RAISE NOTICE 'SKIP % (already hardened)', job_rec.jobname;
      CONTINUE;
    END IF;

    new_command := regexp_replace(
      job_rec.command,
      E'headers\\s*:=\\s*''\\{[^}]*\\}''::jsonb',
      'headers := ' || header_expr,
      'g'
    );

    IF new_command = job_rec.command THEN
      RAISE NOTICE 'FAIL % — headers pattern did not match; inspect manually', job_rec.jobname;
      CONTINUE;
    END IF;

    PERFORM cron.alter_job(job_id := job_rec.jobid, command := new_command);
    rewritten_count := rewritten_count + 1;
    RAISE NOTICE 'OK % (jobid=%)', job_rec.jobname, job_rec.jobid;
  END LOOP;

  RAISE NOTICE '=== Rewrote % cron jobs ===', rewritten_count;
END $$;
```

## Verification query (run after)

```sql
SELECT jobname,
       command LIKE '%x-internal-secret%' AS has_internal_secret,
       command LIKE '%Authorization%' AS still_uses_bearer_authorization
  FROM cron.job
  WHERE command ~ '/functions/v1/(repricer-auto-turbo|repricer-batch-update|repricer-cleanup|repricer-cron-trigger|repricer-evaluate|repricer-priority-cron|repricer-reconcile|repricer-scheduler|repricer-sequential-sweep|repricer-unified-dispatch|enforce-subscription|auto-inventory-sync|backfill-my-price-cache|backfill-order-snapshots|smart-engine-outcome-snapshot|smart-engine-auto-review)[^a-zA-Z0-9_-]'
  ORDER BY jobname;
```

Expected: every row should have `has_internal_secret = true` and
`still_uses_bearer_authorization = false`.

## Smoke test — confirm anonymous callers are rejected

Once the SQL above has run and the edge functions have redeployed
(~30 seconds), from any terminal:

```bash
curl -i -X POST \
  https://mstibdszibcheodvnprm.supabase.co/functions/v1/enforce-subscription \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <ANON_KEY_FROM_BUNDLE>" \
  -d '{}'
```

Expected: `HTTP/2 403 {"error":"Forbidden"}`. Previously this returned 200 and
actually ran subscription enforcement.

## Rollout order + safety

- Edge functions have already redeployed with the guard. **Between the
  redeploy and the cron rewrite below, cron ticks for these 8 jobs will 403.**
  Run the SQL as soon as possible.
- If the SQL fails on any job (a `FAIL` line in the NOTICE output), that
  specific job's command doesn't match the standard `headers := '{...}'::jsonb`
  shape — inspect the raw command with:
  `SELECT command FROM cron.job WHERE jobname = '<name>';` and rewrite by hand.
