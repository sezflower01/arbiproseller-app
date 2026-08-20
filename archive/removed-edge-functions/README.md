# Removed edge functions

Source of edge functions deleted from the Supabase project, kept here **only**
because they existed nowhere else.

`.ts` here so it stays readable and greppable, but this directory is outside
`supabase/functions/` on purpose: the deploy workflow treats every directory
under there as a deployable function, so an archive placed inside it would be
redeployed on the next `_shared` change — resurrecting exactly what was removed.

Nothing here is live, imported, or built. It is a record, not a fallback.

## 2026-08-19

Four functions were deployed but absent from the repo, and stayed invocable
because `deploy-edge-functions.yml` never syncs deletions (deliberate — see its
header). Deleted with `supabase functions delete`.

| Function | Archived here? | Why not |
| --- | --- | --- |
| `admin-scrape-selenium` | **yes** | 0 commits in git history — production was the only copy |
| `admin-upload-asin-csv` | **yes** | 0 commits in git history — production was the only copy |
| `find-source-candidates` | no | 21 commits; recover with `git show ee359a3~1:supabase/functions/find-source-candidates/index.ts` |
| `auto-source-new-listings` | no | 12 commits; recover with `git show ee359a3~1:supabase/functions/auto-source-new-listings/index.ts` |

The first two predate the Lovable export (`35cbd4d`), so they were never in this
repo at all — deleting them would have destroyed the only copy, which is the
whole reason this directory exists.

Verified before deletion: no references from `src/`, no invocations from any
edge function (the two `find-source-candidates` mentions are comments), and no
pg_cron job — `auto-source-new-listings-10min` was unscheduled by
`20260819220000_remove_auto_source_cron.sql`.

`admin-upload-asin-csv` was superseded by `admin-upload-asin-xlsx`, which is in
the repo and still live. `admin-scrape-selenium` drove the old `google-scrape`
path, from before the Find Source work that was itself removed on 2026-08-19.
