-- Momentum Smart V2 raise-safety event columns on repricer_ai_decisions.
-- Mirrors the existing cooldown_applied/max_step_applied/min_price_clamped
-- derived-boolean pattern -- computed from guardsApplied at insert time in
-- repricer-ai-evaluate, not recomputed later. This is the best available
-- historical signal for "was a raise blocked/rejected on this cycle" since
-- post_raise_cooldown_active is a fall-through branch, not a forced SKIP
-- (checking result.mode alone would miss most real occurrences).
alter table public.repricer_ai_decisions
  add column if not exists raise_blocked_cooldown boolean not null default false,
  add column if not exists raise_rejected_floor_support boolean not null default false;

comment on column public.repricer_ai_decisions.raise_blocked_cooldown is
  'true when this cycle hit the MOMENTUM_SMART V2 post_raise_cooldown_hours gate (guardsApplied includes post_raise_cooldown_active)';
comment on column public.repricer_ai_decisions.raise_rejected_floor_support is
  'true when this cycle hit the MOMENTUM_SMART V2 min_floor_support_ratio gate (guardsApplied includes market_supported_raise_rejected)';
