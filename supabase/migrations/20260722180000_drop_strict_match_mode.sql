-- Strict Match Mode is removed as a separate concept. undercut_amount is now
-- the sole source of truth for undercut behavior: 0.00 means "match exactly,
-- never undercut" (the same protection this column used to provide, now
-- derived directly from the number instead of a redundant boolean flag).
--
-- Verified before dropping: every live rule with strict_match_mode = true
-- already had undercut_amount = 0 stored, so no rule's effective pricing
-- behavior changes as a result of this column going away.
ALTER TABLE public.repricer_rules
  DROP COLUMN IF EXISTS strict_match_mode;
