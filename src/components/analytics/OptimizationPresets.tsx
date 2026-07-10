import QueryPresetCard from "./QueryPresetCard";

const presets = [
  {
    name: "Cluster Override Usage",
    description: "How often cluster-based pricing overrides single-outlier anchoring",
    category: "optimization" as const,
    sql: "",
    buildSql: (range: string) => `SELECT
  DATE_TRUNC('day', created_at) AS day,
  COUNT(*) FILTER (WHERE reason ILIKE '%cluster%') AS cluster_events,
  COUNT(*) AS total_actions
FROM repricer_price_actions
WHERE created_at >= NOW() - INTERVAL '${range}'
GROUP BY 1 ORDER BY 1 DESC`,
  },
  {
    name: "Anti-Flip Cooldown Activity",
    description: "Assignments with direction changes tracked — proves cooldown is working",
    category: "optimization" as const,
    sql: "",
    buildSql: (_range: string) => `SELECT
  COUNT(*) AS total_assignments,
  COUNT(*) FILTER (WHERE last_price_direction IS NOT NULL) AS direction_tracked,
  COUNT(*) FILTER (WHERE direction_changed_at IS NOT NULL) AS cooldown_triggered,
  COUNT(*) FILTER (WHERE last_price_direction = 'up') AS direction_up,
  COUNT(*) FILTER (WHERE last_price_direction = 'down') AS direction_down
FROM repricer_assignments
WHERE is_enabled = true`,
  },
  {
    name: "Step Escalation Distribution",
    description: "Distribution of consecutive_failed_undercuts — higher values = more aggressive steps",
    category: "optimization" as const,
    sql: "",
    buildSql: (_range: string) => `SELECT
  CASE
    WHEN consecutive_failed_undercuts = 0 THEN '0 (no failures)'
    WHEN consecutive_failed_undercuts BETWEEN 1 AND 2 THEN '1-2 (normal)'
    WHEN consecutive_failed_undercuts BETWEEN 3 AND 4 THEN '3-4 (escalating 50%)'
    WHEN consecutive_failed_undercuts >= 5 THEN '5+ (escalating 100%)'
  END AS bucket,
  COUNT(*) AS count
FROM repricer_assignments
WHERE is_enabled = true
GROUP BY 1 ORDER BY MIN(consecutive_failed_undercuts)`,
  },
  {
    name: "Floor Pressure Trend",
    description: "Hourly average of min_bound constraints from monitor snapshots",
    category: "optimization" as const,
    sql: "",
    buildSql: (range: string) => `SELECT
  DATE_TRUNC('hour', captured_at) AS hour,
  AVG(constraint_min_bound) AS avg_min_bound,
  AVG(constraint_profit_guard) AS avg_profit_guard
FROM repricer_monitor_snapshots
WHERE captured_at >= NOW() - INTERVAL '${range}'
GROUP BY 1 ORDER BY 1 DESC`,
  },
  {
    name: "Adaptive Floor Relaxation Events",
    description: "Price actions where adaptive floor relaxation was triggered",
    category: "optimization" as const,
    sql: "",
    buildSql: (range: string) => `SELECT
  DATE_TRUNC('day', created_at) AS day,
  COUNT(*) FILTER (WHERE reason ILIKE '%adaptive%' OR reason ILIKE '%floor_blocked_cycles%') AS adaptive_events,
  COUNT(*) FILTER (WHERE reason ILIKE '%min_price%') AS min_price_blocks,
  COUNT(*) AS total
FROM repricer_price_actions
WHERE created_at >= NOW() - INTERVAL '${range}'
GROUP BY 1 ORDER BY 1 DESC`,
  },
  {
    name: "Oscillation State Distribution",
    description: "Current oscillation state across all enabled assignments",
    category: "optimization" as const,
    sql: "",
    buildSql: (_range: string) => `SELECT
  COALESCE(oscillation_state, 'none') AS osc_state,
  COUNT(*) AS count
FROM repricer_assignments
WHERE is_enabled = true
GROUP BY 1 ORDER BY count DESC`,
  },
  {
    name: "Raise Offset Policy (Match vs Undercut)",
    description: "How often raises use $0.00 match vs $0.01 undercut — tracks conditional offset decisions",
    category: "optimization" as const,
    sql: "",
    buildSql: (range: string) => `SELECT
  CASE
    WHEN reason ILIKE '%raise_offset_match%' THEN 'Match ($0.00)'
    WHEN reason ILIKE '%raise_offset_undercut%' THEN 'Undercut ($0.01)'
    ELSE 'No offset tag'
  END AS offset_policy,
  COUNT(*) AS count,
  ROUND(AVG(price_delta)::numeric, 3) AS avg_delta
FROM repricer_price_actions
WHERE created_at >= NOW() - INTERVAL '${range}'
  AND action_type = 'price_change'
  AND price_delta > 0
GROUP BY 1 ORDER BY count DESC`,
  },
  {
    name: "Raise Offset Breakdown by Reason",
    description: "Detailed breakdown of which offset reason triggered most often",
    category: "optimization" as const,
    sql: "",
    buildSql: (range: string) => `SELECT
  unnest(
    ARRAY(
      SELECT unnest(string_to_array(reason, ','))
    )
  ) AS guard_tag,
  COUNT(*) AS count
FROM repricer_price_actions
WHERE created_at >= NOW() - INTERVAL '${range}'
  AND action_type = 'price_change'
  AND price_delta > 0
  AND reason ILIKE '%raise_offset_%'
GROUP BY 1
HAVING unnest ILIKE '%raise_offset_%'
ORDER BY count DESC`,
  },
];

export default function OptimizationPresets() {
  return (
    <div className="grid gap-4 mt-4">
      {presets.map((p) => (
        <QueryPresetCard key={p.name} preset={p} />
      ))}
    </div>
  );
}
