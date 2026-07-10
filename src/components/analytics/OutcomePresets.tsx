import QueryPresetCard from "./QueryPresetCard";

const presets = [
  {
    name: "Buy Box Recovery Speed",
    description: "Average time from BB loss to next price action for winning ASINs",
    category: "outcome" as const,
    sql: "",
    buildSql: (_range: string) => `SELECT
  asin, marketplace,
  last_buybox_status,
  buybox_lost_at,
  last_applied_at,
  CASE WHEN buybox_lost_at IS NOT NULL AND last_applied_at > buybox_lost_at
    THEN ROUND(EXTRACT(EPOCH FROM (last_applied_at - buybox_lost_at)) / 3600, 1)
    ELSE NULL
  END AS recovery_hours
FROM repricer_assignments
WHERE buybox_lost_at IS NOT NULL AND is_enabled = true
ORDER BY buybox_lost_at DESC
LIMIT 30`,
  },
  {
    name: "Write Effectiveness",
    description: "Percentage of price actions that resulted in successful writes",
    category: "outcome" as const,
    sql: "",
    buildSql: (range: string) => `SELECT
  COUNT(*) FILTER (WHERE action_type = 'price_changed' AND success = true) AS successful_writes,
  COUNT(*) FILTER (WHERE action_type = 'price_changed') AS total_writes,
  COUNT(*) AS total_actions,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE action_type = 'price_changed' AND success = true)
    / NULLIF(COUNT(*), 0), 2
  ) AS write_rate_pct
FROM repricer_price_actions
WHERE created_at >= NOW() - INTERVAL '${range}'`,
  },
  {
    name: "BB Win/Loss Trend",
    description: "Buy Box status distribution across enabled assignments",
    category: "outcome" as const,
    sql: "",
    buildSql: (_range: string) => `SELECT
  COALESCE(last_buybox_status, 'unknown') AS bb_status,
  COUNT(*) AS count
FROM repricer_assignments
WHERE is_enabled = true AND rule_id IS NOT NULL
GROUP BY 1 ORDER BY count DESC`,
  },
  {
    name: "Top Constraint Reasons",
    description: "Most common reasons price changes are blocked",
    category: "outcome" as const,
    sql: "",
    buildSql: (range: string) => `SELECT
  CASE
    WHEN reason ILIKE '%min_price%' THEN 'Min Floor'
    WHEN reason ILIKE '%profit_guard%' OR reason ILIKE '%blocked_by_profit%' THEN 'Profit Guard'
    WHEN reason ILIKE '%BB owner protection%' THEN 'BB Owner Hold'
    WHEN reason ILIKE '%cooldown%' THEN 'Cooldown'
    WHEN reason ILIKE '%No eligible%' THEN 'No Competitors'
    WHEN reason ILIKE '%patience hold%' THEN 'Patience Hold'
    WHEN reason ILIKE '%Stock-gated%' THEN 'Stock-Gated'
    WHEN reason ILIKE '%Monopoly%' THEN 'Monopoly'
    WHEN reason ILIKE '%oscillation%' THEN 'Oscillation Guard'
    ELSE 'Other'
  END AS constraint_type,
  COUNT(*) AS count
FROM repricer_price_actions
WHERE created_at >= NOW() - INTERVAL '${range}'
  AND action_type IN ('no_change', 'blocked_by_profit_guard', 'oscillation_guard')
GROUP BY 1 ORDER BY count DESC`,
  },
  {
    name: "Price Movement Summary",
    description: "Average price delta and direction for actual price changes",
    category: "outcome" as const,
    sql: "",
    buildSql: (range: string) => `SELECT
  CASE WHEN new_price > old_price THEN 'Raised' WHEN new_price < old_price THEN 'Lowered' ELSE 'Unchanged' END AS direction,
  COUNT(*) AS count,
  ROUND(AVG(ABS(new_price - old_price))::numeric, 2) AS avg_delta,
  ROUND(AVG(ABS(new_price - old_price) / NULLIF(old_price, 0) * 100)::numeric, 2) AS avg_pct
FROM repricer_price_actions
WHERE created_at >= NOW() - INTERVAL '${range}'
  AND action_type = 'price_changed'
  AND old_price > 0
GROUP BY 1 ORDER BY count DESC`,
  },
  {
    name: "Before vs After Comparison (72h)",
    description: "Compare key metrics: last 36h vs previous 36h",
    category: "outcome" as const,
    sql: "",
    buildSql: (_range: string) => `WITH recent AS (
  SELECT * FROM repricer_price_actions WHERE created_at >= NOW() - INTERVAL '36 hours'
), prior AS (
  SELECT * FROM repricer_price_actions WHERE created_at >= NOW() - INTERVAL '72 hours' AND created_at < NOW() - INTERVAL '36 hours'
)
SELECT
  'Last 36h' AS period,
  COUNT(*) AS total_actions,
  COUNT(*) FILTER (WHERE action_type = 'price_changed') AS writes,
  COUNT(*) FILTER (WHERE action_type = 'no_change') AS holds,
  COUNT(*) FILTER (WHERE action_type = 'price_change_failed') AS errors,
  ROUND(100.0 * COUNT(*) FILTER (WHERE action_type = 'price_changed') / NULLIF(COUNT(*), 0), 1) AS write_pct
FROM recent
UNION ALL
SELECT
  'Prior 36h' AS period,
  COUNT(*), COUNT(*) FILTER (WHERE action_type = 'price_changed'),
  COUNT(*) FILTER (WHERE action_type = 'no_change'),
  COUNT(*) FILTER (WHERE action_type = 'price_change_failed'),
  ROUND(100.0 * COUNT(*) FILTER (WHERE action_type = 'price_changed') / NULLIF(COUNT(*), 0), 1)
FROM prior`,
  },
];

export default function OutcomePresets() {
  return (
    <div className="grid gap-4 mt-4">
      {presets.map((p) => (
        <QueryPresetCard key={p.name} preset={p} />
      ))}
    </div>
  );
}
