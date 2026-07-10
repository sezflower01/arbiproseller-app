UPDATE public.repricer_assignments
SET is_priority = true,
    is_manual_priority = true,
    last_priority_check_at = NULL,
    next_rainforest_check_at = NULL,
    oscillation_cooldown_until = NULL,
    updated_at = now()
WHERE id = 'ef2ac1f1-c59c-4711-af8e-d4f3e8797454';