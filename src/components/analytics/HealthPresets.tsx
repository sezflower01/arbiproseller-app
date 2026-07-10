import QueryPresetCard from "./QueryPresetCard";

const presets = [
  {
    name: "Evals & Writes per Hour",
    description: "Hourly evaluation and write throughput to detect engine slowdowns",
    category: "health" as const,
    sql: "",
    buildSql: (range: string) => `SELECT
  DATE_TRUNC('hour', created_at) AS hour,
  COUNT(*) AS total_actions,
  COUNT(*) FILTER (WHERE action_type = 'price_changed') AS writes,
  COUNT(*) FILTER (WHERE action_type = 'no_change') AS no_change,
  COUNT(*) FILTER (WHERE action_type = 'blocked_by_profit_guard') AS profit_guard
FROM repricer_price_actions
WHERE created_at >= NOW() - INTERVAL '${range}'
GROUP BY 1 ORDER BY 1 DESC`,
  },
  {
    name: "Error Rate Trend",
    description: "Hourly error count from price actions — should be near zero after oscState fix",
    category: "health" as const,
    sql: "",
    buildSql: (range: string) => `SELECT
  DATE_TRUNC('hour', created_at) AS hour,
  COUNT(*) FILTER (WHERE action_type = 'price_change_failed') AS failed,
  COUNT(*) FILTER (WHERE action_type = 'oscillation_guard') AS osc_guard,
  COUNT(*) AS total
FROM repricer_price_actions
WHERE created_at >= NOW() - INTERVAL '${range}'
GROUP BY 1 ORDER BY 1 DESC`,
  },
  {
    name: "Monitor Snapshot Health",
    description: "5-min health score, coverage, BB wins/losses from snapshots",
    category: "health" as const,
    sql: "",
    buildSql: (range: string) => `SELECT
  captured_at, health_score, coverage_pct,
  writes_24h, evals_24h,
  constraint_profit_guard, constraint_min_bound,
  bb_winning, bb_losing
FROM repricer_monitor_snapshots
WHERE captured_at >= NOW() - INTERVAL '${range}'
  AND user_id = auth.uid()
ORDER BY captured_at DESC
LIMIT 100`,
  },
  {
    name: "HOT Freshness Trend",
    description: "Track HOT ASIN staleness — truly_stale should stay at 0",
    category: "health" as const,
    sql: "",
    buildSql: (range: string) => `SELECT
  captured_at,
  hot_eligible, hot_dispatchable, hot_blocked, hot_truly_stale,
  hot_p50_minutes, hot_p90_minutes
FROM repricer_monitor_snapshots
WHERE captured_at >= NOW() - INTERVAL '${range}'
  AND user_id = auth.uid()
ORDER BY captured_at DESC
LIMIT 100`,
  },
  {
    name: "Circuit Breaker Events",
    description: "Assignments with consecutive failures — signs of engine crashes",
    category: "health" as const,
    sql: "",
    emptyMessage: "✅ No failures — all assignments have consecutive_failures = 0. This is healthy.",
    buildSql: (_range: string) => `SELECT asin, marketplace, consecutive_failures, last_error_type, last_error_message, last_failure_at
FROM repricer_assignments
WHERE consecutive_failures > 0
ORDER BY consecutive_failures DESC
LIMIT 20`,
  },
];

export default function HealthPresets() {
  return (
    <div className="grid gap-4 mt-4">
      {presets.map((p) => (
        <QueryPresetCard key={p.name} preset={p} />
      ))}
    </div>
  );
}
