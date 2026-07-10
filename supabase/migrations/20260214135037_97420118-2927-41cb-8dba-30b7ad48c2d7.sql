-- Resume all paused_profit_guard and paused assignments back to active
-- These items have been stuck and not evaluated by the scheduler
UPDATE public.repricer_assignments 
SET status = 'active', 
    paused_reason = null, 
    paused_until = null, 
    consecutive_profit_guard_hits = 0,
    auto_resumed_at = now(),
    updated_at = now()
WHERE status IN ('paused_profit_guard', 'paused');