// Lightweight pub/sub used by Monitor panels.
//
// Background: automatic polling across ~17 monitor panels was the dominant
// source of repricer_assignments / repricer_price_actions CPU load on the
// database. We replaced all per-panel setInterval timers with a single
// user-triggered "Refresh" event. Each panel still loads ONCE on mount,
// then only re-fetches when the user clicks the global Refresh button.
//
// Repricer logic, evaluator, rules, cron, FX, and marketplace behavior are
// not affected — this only changes how often the diagnostics dashboard
// re-reads from Postgres.

type Listener = () => void;
const listeners = new Set<Listener>();

export function onMonitorRefresh(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function emitMonitorRefresh(): void {
  listeners.forEach((l) => {
    try {
      l();
    } catch {
      /* swallow — one panel must not break others */
    }
  });
}
