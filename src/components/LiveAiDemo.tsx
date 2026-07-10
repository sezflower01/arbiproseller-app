import { useEffect, useMemo, useState } from "react";
import { Activity, Clock3, ShieldCheck, Sparkles, TrendingUp, Brain } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface DemoItem {
  id: string;
  asin: string;
  title: string;
  current: number;
  buyBox: number;
  evaluatedAt: number; // epoch ms
  actionAt: number;
  actionType: "price_changed" | "no_change" | "protected";
  triggerSource: string;
  flash?: number; // last flash timestamp
}

const seed: DemoItem[] = [
  {
    id: "1",
    asin: "B01MT0ATS6",
    title: "Kemper Tools Element Staples (12-pack), heat-resistant to 2500°F",
    current: 13.69,
    buyBox: 13.22,
    evaluatedAt: Date.now() - 15_000,
    actionAt: Date.now() - 15_000,
    actionType: "price_changed",
    triggerSource: "priority cron",
  },
  {
    id: "2",
    asin: "B0FZ5TTH57",
    title: "Coastal Collection Essential Oil Set, 4 Pieces, 0.5 Fl Oz",
    current: 29.38,
    buyBox: 29.01,
    evaluatedAt: Date.now() - 17_000,
    actionAt: Date.now() - 18_000,
    actionType: "price_changed",
    triggerSource: "priority cron",
  },
  {
    id: "3",
    asin: "B075FXGNN8",
    title: 'Name Badges with Lanyards, Print or Write, 3" x 4", 100 Inserts',
    current: 59.97,
    buyBox: 49.98,
    evaluatedAt: Date.now() - 20_000,
    actionAt: Date.now() - 20_000,
    actionType: "price_changed",
    triggerSource: "priority cron",
  },
  {
    id: "4",
    asin: "B01797D8BY",
    title: "Browning Groove Gauge, Plastic",
    current: 17.0,
    buyBox: 13.34,
    evaluatedAt: Date.now() - 23_000,
    actionAt: Date.now() - 23_000,
    actionType: "no_change",
    triggerSource: "priority cron",
  },
  {
    id: "5",
    asin: "B07WS1H7SJ",
    title: "Ilco Taylor SC4-BR Key Blank, for SCH C 6 PIN (50-Pack)",
    current: 21.8,
    buyBox: 17.99,
    evaluatedAt: Date.now() - 25_000,
    actionAt: Date.now() - 25_000,
    actionType: "price_changed",
    triggerSource: "priority cron",
  },
  {
    id: "6",
    asin: "B0083LE41Y",
    title: "Red Heart Super Saver Jumbo Yarn, Cafe Latte",
    current: 14.42,
    buyBox: 7.48,
    evaluatedAt: Date.now() - 28_000,
    actionAt: Date.now() - 28_000,
    actionType: "protected",
    triggerSource: "priority cron",
  },
];

function formatRelative(ts: number, now: number) {
  const diff = Math.max(0, Math.floor((now - ts) / 1000));
  if (diff < 60) return `${diff}s ago`;
  const m = Math.floor(diff / 60);
  if (m < 60) return `${m}m ${diff % 60}s ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}

function formatCountdown(ts: number, now: number) {
  const diff = Math.max(0, ts - now);
  if (diff <= 0) return "now";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

const getLabel = (a: DemoItem["actionType"]) => {
  if (a === "price_changed") return "Price updated";
  if (a === "protected") return "Protected by floor";
  return "Holding";
};

const getBadgeClass = (a: DemoItem["actionType"]) => {
  if (a === "price_changed") return "border-primary/30 bg-primary/10 text-primary";
  if (a === "protected") return "border-accent/40 bg-accent text-accent-foreground";
  return "border-border/60 bg-muted/40 text-foreground";
};

const LiveAiDemo = () => {
  const [items, setItems] = useState<DemoItem[]>(seed);
  const [now, setNow] = useState(Date.now());
  const [nextRunAt, setNextRunAt] = useState(Date.now() + 120_000);
  const [lastRunAt, setLastRunAt] = useState(Date.now() - 8_000);

  // Tick every second for relative time + countdowns
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  // Simulate engine evaluations every ~6s
  useEffect(() => {
    const t = window.setInterval(() => {
      setItems((prev) => {
        const idx = Math.floor(Math.random() * prev.length);
        const next = [...prev];
        const cur = next[idx];
        const tsNow = Date.now();
        const roll = Math.random();
        let newAction: DemoItem["actionType"] = "no_change";
        let newPrice = cur.current;
        const newBB = Math.max(0.5, +(cur.buyBox + (Math.random() - 0.5) * 0.4).toFixed(2));

        if (roll < 0.55) {
          newAction = "price_changed";
          const delta = +(Math.random() * 0.5 - 0.05).toFixed(2);
          newPrice = Math.max(1, +(cur.current + delta).toFixed(2));
        } else if (roll < 0.8) {
          newAction = "no_change";
        } else {
          newAction = "protected";
        }

        next[idx] = {
          ...cur,
          current: newPrice,
          buyBox: newBB,
          evaluatedAt: tsNow,
          actionAt: tsNow,
          actionType: newAction,
          flash: tsNow,
        };
        // Move updated item to the top for "live" feel
        const updated = next.splice(idx, 1)[0];
        return [updated, ...next];
      });
      setLastRunAt(Date.now());
      setNextRunAt(Date.now() + 90_000 + Math.floor(Math.random() * 60_000));
    }, 6000);
    return () => window.clearInterval(t);
  }, []);

  const lastRunRel = useMemo(() => formatRelative(lastRunAt, now), [lastRunAt, now]);
  const nextRunRel = useMemo(() => formatCountdown(nextRunAt, now), [nextRunAt, now]);

  return (
    <section
      className="relative overflow-hidden py-24 bg-gradient-to-br from-[hsl(222,84%,4.9%)] via-[hsl(230,50%,10%)] to-[hsl(260,50%,8%)]"
      aria-label="Live AI demo"
    >
      {/* Animated gradient orbs (matches Hero) */}
      <div className="pointer-events-none absolute -left-32 top-1/4 h-96 w-96 rounded-full bg-primary/20 blur-[120px] animate-pulse" />
      <div
        className="pointer-events-none absolute -right-32 bottom-1/4 h-96 w-96 rounded-full bg-purple-500/15 blur-[120px] animate-pulse"
        style={{ animationDelay: "1s" }}
      />
      <div className="pointer-events-none absolute left-1/2 top-1/2 h-[600px] w-[600px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/5 blur-[200px]" />

      {/* Grid pattern overlay */}
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:64px_64px]" />

      <div className="container relative z-10 mx-auto px-4">
        <div className="mx-auto mb-12 max-w-3xl text-center">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-4 py-1.5 text-sm font-medium text-primary backdrop-blur-sm">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
            </span>
            Watch AI reprice live
          </div>
          <h2 className="font-display text-4xl font-bold leading-tight tracking-tight text-white md:text-5xl">
            Live AI in{" "}
            <span className="bg-gradient-to-r from-primary via-blue-400 to-purple-400 bg-clip-text text-transparent">
              Action
            </span>
          </h2>
          <p className="mx-auto mt-4 max-w-2xl text-base leading-relaxed text-muted-foreground md:text-lg">
            See how the engine evaluates listings continuously — raising when it can,
            holding when it should, and protecting your floor automatically.
          </p>
        </div>

        <div className="mx-auto grid max-w-6xl gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1.9fr)]">
          {/* Scheduler card */}
          <div className="rounded-2xl border border-white/10 bg-white/5 p-5 shadow-2xl backdrop-blur-xl">
            <div className="mb-4 flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/15 ring-1 ring-primary/30">
                <Sparkles className="h-4 w-4 text-primary" />
              </div>
              <h3 className="text-sm font-semibold text-white">Scheduler status</h3>
            </div>

            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2.5 py-1 text-xs font-medium text-emerald-300">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                Active
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
                Evaluating
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Last run</p>
                <p className="mt-1 font-display text-sm font-semibold text-white">{lastRunRel}</p>
              </div>
              <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Next AI check</p>
                <p className="mt-1 font-display text-sm font-semibold text-white">{nextRunRel}</p>
              </div>
            </div>

            <div className="mt-3 space-y-2 rounded-xl border border-white/10 bg-white/[0.03] p-3 text-xs text-muted-foreground">
              <div className="flex items-center gap-2">
                <TrendingUp className="h-3.5 w-3.5 text-primary" />
                <span>Raises when market allows</span>
              </div>
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
                <span>Protects min price &amp; ROI floor</span>
              </div>
              <div className="flex items-center gap-2">
                <Clock3 className="h-3.5 w-3.5 text-purple-400" />
                <span>Reacts in seconds, not hours</span>
              </div>
            </div>
          </div>

          {/* Live evaluation feed */}
          <div className="grid gap-3 md:grid-cols-2">
            {items.slice(0, 6).map((item) => {
              const flashing = item.flash && now - item.flash < 1500;
              return (
                <div
                  key={item.id}
                  className={cn(
                    "group rounded-2xl border border-white/10 bg-white/5 p-4 shadow-xl backdrop-blur-xl transition-all duration-500",
                    flashing
                      ? "ring-2 ring-primary/50 shadow-[0_0_30px_-5px_hsl(var(--primary)/0.4)]"
                      : "hover:border-white/20 hover:bg-white/[0.07]"
                  )}
                >
                  <div className="mb-3 flex items-start gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-gradient-to-br from-primary/20 to-purple-500/10">
                      <Activity className="h-4 w-4 text-primary" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs font-semibold tracking-wide text-white">
                          {item.asin}
                        </span>
                        <span
                          className={cn(
                            "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium",
                            item.actionType === "price_changed" &&
                              "border-primary/40 bg-primary/15 text-primary",
                            item.actionType === "protected" &&
                              "border-emerald-400/40 bg-emerald-400/10 text-emerald-300",
                            item.actionType === "no_change" &&
                              "border-white/15 bg-white/5 text-muted-foreground"
                          )}
                        >
                          {getLabel(item.actionType)}
                        </span>
                      </div>
                      <p className="mt-1 truncate text-xs text-muted-foreground">{item.title}</p>
                    </div>
                  </div>

                  <div className="mb-3 grid grid-cols-2 gap-2">
                    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-2.5">
                      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Current</p>
                      <p
                        className={cn(
                          "mt-0.5 font-display text-base font-semibold tabular-nums transition-colors",
                          flashing ? "text-primary" : "text-white"
                        )}
                      >
                        ${item.current.toFixed(2)}
                      </p>
                    </div>
                    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-2.5">
                      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Buy Box</p>
                      <p className="mt-0.5 font-display text-base font-semibold tabular-nums text-white">
                        ${item.buyBox.toFixed(2)}
                      </p>
                    </div>
                  </div>

                  <div className="space-y-1.5 text-xs">
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <Clock3 className="h-3.5 w-3.5" />
                      <span>Evaluated {formatRelative(item.evaluatedAt, now)}</span>
                    </div>
                    <div className="flex items-start gap-1.5 text-gray-200">
                      {item.actionType === "price_changed" ? (
                        <TrendingUp className="mt-0.5 h-3.5 w-3.5 text-primary" />
                      ) : (
                        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 text-emerald-400" />
                      )}
                      <span className="line-clamp-2">
                        {item.actionType === "price_changed"
                          ? `🧠 AI reduced price to win Buy Box while staying profitable`
                          : item.actionType === "protected"
                          ? "🧠 AI held — below profitable threshold"
                          : "🧠 AI confirmed optimal position — no change needed"}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2 text-gray-500">
                      <span>Updated {formatRelative(item.actionAt, now)}</span>
                      <span className="capitalize">{item.triggerSource}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <p className="mt-8 text-center text-xs text-gray-500">
          Demonstration uses simulated data. Real users see their own live ASINs inside the app.
        </p>
      </div>
    </section>
  );
};

export default LiveAiDemo;

