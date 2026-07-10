-- Delete old competitor snapshots (keep last 48 hours)
DELETE FROM public.repricer_competitor_snapshots 
WHERE fetched_at < NOW() - INTERVAL '48 hours';

-- Delete old skip/no-change price actions (keep last 7 days)
DELETE FROM public.repricer_price_actions 
WHERE created_at < NOW() - INTERVAL '7 days'
  AND action_type IN ('skip', 'no_change', 'cooldown', 'skipped');

-- Delete old applied/error price actions (keep last 30 days)
DELETE FROM public.repricer_price_actions 
WHERE created_at < NOW() - INTERVAL '30 days';