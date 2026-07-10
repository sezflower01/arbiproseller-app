import { useEffect, useRef } from "react";

/**
 * CPU-safe polling helper. Same shape as setInterval, but:
 *  - skips ticks when the browser tab is hidden (document.hidden)
 *  - runs `fn` once on mount and once when the tab becomes visible again
 *    (only if more than `ms` ms have elapsed since the last run)
 *
 * Used by Monitor / diagnostics panels so they don't burn DB CPU
 * when the user has the dashboard left open in a background tab.
 *
 * Drop-in replacement for:
 *   useEffect(() => { fn(); const i = setInterval(fn, ms); return () => clearInterval(i); }, [fn]);
 */
export function useVisibleInterval(fn: () => void | Promise<void>, ms: number) {
  const fnRef = useRef(fn);
  const lastRunRef = useRef(0);

  // Always call the latest fn without re-creating the interval on every render
  useEffect(() => {
    fnRef.current = fn;
  }, [fn]);

  useEffect(() => {
    let cancelled = false;

    const run = () => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.hidden) return;
      lastRunRef.current = Date.now();
      try {
        const r = fnRef.current();
        if (r && typeof (r as any).then === "function") {
          (r as Promise<void>).catch(() => {});
        }
      } catch {
        /* swallow */
      }
    };

    // initial run
    run();

    const id = window.setInterval(run, ms);

    const onVisibility = () => {
      if (document.hidden) return;
      // If the tab was hidden for longer than `ms`, refresh immediately
      if (Date.now() - lastRunRef.current >= ms) run();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [ms]);
}
