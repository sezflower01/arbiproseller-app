---
name: Instant Inbound Auto-Activation
description: Inbound>0 on active/buyable listings triggers default-rule attach + ROI-floor min + max + live price raise, every 5min via cron; new rows pinned to top of AssignmentsTable
type: feature
---

When `inventory.inbound > 0` for an active listing, the repricer auto-activates the assignment immediately — no waiting for available stock, no manual setup.

**Pipeline:**
- Cron `auto-activate-inbound-5min` (`*/5 * * * *`) hits `auto-activate-inbound-all`
- Fans out per user (with inbound > 0, non-DELETED/NOT_IN_CATALOG/INCOMPLETE) × `US/CA/MX/BR`
- Each leg calls `auto-assign-bulk` (the existing single-marketplace function does the full default-rule + ROI floor + min/max + live price auto-raise flow)
- Run audit in `auto_activate_runs` (per-user: candidates / activated / re_enabled / auto_raised / error)
- Concurrency: `try_acquire_cron_lock('auto_activate_inbound_all', 600)`; per-user calls staggered 800ms

**`auto-assign-bulk` changes:**
- New inserts stamp `auto_activated_at`, `auto_activated_by='auto_assign_bulk'`, `auto_activated_reason` (`inbound_detected` | `inbound_plus_stock` | `stock_detected`) + `last_enabled_*` audit fields
- Re-enable block (7b) now includes inbound: `available+reserved > 0 → 'stock_detected'`, else `inbound > 0 → 'inbound_detected'`. Re-enabled rows also stamp the auto-activation audit fields so they pin to top.

**Rules respected (unchanged):**
- Default rule resolved via `repricer_rules.is_default = true` (refuses to auto-pick a preset if no default — same as before)
- Min = ROI floor (`MAX(roiFloor, $5)`), Max = `roiFloor × 1.35` or ref × 1.2 (whichever is larger)
- If current price < ROI floor, fires `update-amazon-price` immediately to raise live price to floor (auto-raise candidate path — pre-existing)
- AUTO_FLOOR_LOWERED stays disabled; this flow only raises floors, never lowers

**Schema:**
- `repricer_assignments.auto_activated_at TIMESTAMPTZ`, `auto_activated_by TEXT`, `auto_activated_reason TEXT`
- Index `idx_repricer_assignments_user_auto_activated (user_id, auto_activated_at DESC) WHERE auto_activated_at IS NOT NULL`
- `auto_activate_runs` table (own-user RLS read)

**Frontend (`AssignmentsTable.tsx`):**
- `InventoryWithAssignment` carries `auto_activated_at` + `auto_activated_reason`
- After `sortList`, `pinNewInbound` pulls rows with `auto_activated_at` within last 24h to the top (ordered newest-first); rest keep user's sort
- Amber "🆕 New inbound" pill rendered next to SKU for 24h after activation; tooltip shows timestamp + reason

**Why not a new edge function**: `auto-assign-bulk` already implements the entire default-rule + ROI floor + min/max + auto-raise live-price flow. We just wrap it with a cron-driven per-user fan-out + audit stamping.
