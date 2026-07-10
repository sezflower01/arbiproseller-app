# Realtime Channel Inventory

Every `supabase.channel(...)` site in `src/` has one of four scopings. Any new
channel must pick one and document it here.

See `src/lib/realtime/scopedChannel.ts` for the helpers and the reasoning
behind the contract.

## Categories

- **user-scoped** — channel name includes `user.id`. Default choice for any
  tenant-owned table. Bounds Realtime fan-out to a single account's tabs and
  bounds any future RLS regression to that account's data.
- **session-scoped** — channel name is keyed by a per-user secret (e.g. a
  chat session id). RLS on the underlying table must independently gate the
  session id to its participants.
- **shared-admin** — channel name is deliberately shared across all admin
  tabs. Only valid when the underlying table has admin-only RLS SELECT
  (`has_role(auth.uid(), 'admin')`) AND the caller gates `subscribe()`
  behind an `isAdmin` check.
- **legacy-shared** — historical shared channel names kept temporarily for
  compatibility. New code must not add these; convert to user-scoped.

## Inventory (audited 2026-07-03)

| Site | Channel | Category | Table RLS |
| --- | --- | --- | --- |
| `LiveChatWidget.tsx` | `chat-msg-${sessionId}` | session-scoped | `chat_messages` participant-only |
| `LiveChatWidget.tsx` | `chat-sess-${sessionId}` | session-scoped | `chat_sessions` participant-only |
| `AdminChatPanel.tsx` | `admin-chat-msg-${sessionId}` | session-scoped | `chat_messages` admin OR participant |
| `AdminChatNotification.tsx` | `admin-chat-sessions` | shared-admin | `chat_sessions` admin SELECT |
| `AdminErrorNotification.tsx` | `admin-error-reports` | shared-admin | `error_reports` admin SELECT |
| `AdminErrorNotification.tsx` | `admin-repricer-errors` | shared-admin | `repricer_price_actions` admin SELECT |
| `AssignmentsTable.tsx` | `repricer-inventory-live-${user.id}-${mkt}` | user-scoped | `inventory` `user_id = auth.uid()` |
| `AssignmentsTable.tsx` | `assignments-lock-${user.id}` | user-scoped | `repricer_assignments` `user_id = auth.uid()` |
| `AutomationSearch.tsx` | `automation-results-${user.id}-${runId}` | user-scoped (fixed 2026-07-03) | `automation_results` via `automation_runs.user_id = auth.uid()` |
| `AutomationSearch.tsx` | `automation-runs-${user.id}-${runId}` | user-scoped (fixed 2026-07-03) | `automation_runs` `user_id = auth.uid()` |
| `ActionLogDialog.tsx` | `action-log-${user.id}-${asin}-${sku}-${mkt}` | user-scoped (fixed 2026-07-03) | `repricer_assignments` `user_id = auth.uid()` |
| `CheckedRecentlyPanel.tsx` | `checked-recently-${user.id}` | user-scoped (fixed 2026-07-03) | `repricer_price_actions` `user_id = auth.uid()` |

## Adding a new channel

1. Import the appropriate helper from `src/lib/realtime/scopedChannel.ts`.
2. Confirm the underlying table's RLS SELECT policy matches the scoping
   category you picked (this doc's last column). If it doesn't, fix the
   RLS first; don't try to compensate with the channel name.
3. Add an entry to the table above in the same PR.
