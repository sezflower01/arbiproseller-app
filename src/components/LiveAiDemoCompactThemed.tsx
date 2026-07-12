import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, Clock3, ShieldCheck, Sparkles, TrendingUp, Eye, RefreshCw, ChevronDown, Brain } from "lucide-react";
import { cn } from "@/lib/utils";

// Re-themed copy of LiveAiDemoCompact.tsx for the "InventoryHub" light identity.
// Simulation logic, data pool, and timing are byte-for-byte identical — only
// classNames changed (hardcoded dark literals -> semantic tokens) plus the
// inert `font-display` class swapped for the real `font-ih-display` utility
// (the former isn't wired to any Tailwind fontFamily key in this codebase, so
// it never rendered a display font; this is the InventoryHub theme's display
// font, matching every other themed page's stat/heading treatment).

interface DemoItem {
  id: string;
  asin: string;
  title: string;
  image: string;
  current: number;
  buyBox: number | null;
  evaluatedAt: number;
  actionAt: number;
  actionType: "price_changed" | "no_change" | "protected";
  flash?: number;
}

const productPool: Omit<DemoItem, "id" | "evaluatedAt" | "actionAt" | "actionType">[] = [
  { asin: "B0G54JL52W", title: "POP TV: Stranger Things - Dustin Henderson (Season 5) Funko Vinyl Figure, 3.75 inches", image: "https://images.unsplash.com/photo-1608889335941-32ac5f2041b9?w=200&h=200&fit=crop&auto=format", current: 28.87, buyBox: null },
  { asin: "B0GNC6CRCD", title: "2026 Topps Series 1 MLB Baseball Fat Pack", image: "https://images.unsplash.com/photo-1508098682722-e99c43a406b2?w=200&h=200&fit=crop&auto=format", current: 12.99, buyBox: null },
  { asin: "B0GGMLFGPG", title: "Kinder's Rubs & Seasonings - 1 bottle (Bourbon Peach 5.8oz)", image: "https://images.unsplash.com/photo-1599909533042-2e88b29c8c4d?w=200&h=200&fit=crop&auto=format", current: 13.49, buyBox: 15.99 },
  { asin: "B0GT62JDVT", title: "2026 Topps Heritage Baseball - Mega Box - Factory Sealed", image: "https://images.unsplash.com/photo-1567593810070-7a3d471af022?w=200&h=200&fit=crop&auto=format", current: 88.89, buyBox: null },
  { asin: "B0FS8378QJ", title: "POP TV: Arcane League of Legends - Jinx Funko Vinyl Figure, 3.75 inches", image: "https://images.unsplash.com/photo-1635805737707-575885ab0820?w=200&h=200&fit=crop&auto=format", current: 34.95, buyBox: null },
  { asin: "B0DQVSH65Z", title: "Lang Companies, Wild At Heart Deluxe 2026 Planner, 8.25'' X 9.5''", image: "https://images.unsplash.com/photo-1506784983877-45594efa4cbe?w=200&h=200&fit=crop&auto=format", current: 19.01, buyBox: 18.99 },
  { asin: "B07XJ8C8F5", title: "Apple AirPods Pro (2nd Generation) Wireless Earbuds with MagSafe Charging Case", image: "https://images.unsplash.com/photo-1600294037681-c80b4cb5b434?w=200&h=200&fit=crop&auto=format", current: 189.99, buyBox: 199.0 },
  { asin: "B08N5WRWNW", title: "Echo Dot (4th Gen) Smart speaker with Alexa - Charcoal", image: "https://images.unsplash.com/photo-1543512214-318c7553f230?w=200&h=200&fit=crop&auto=format", current: 29.99, buyBox: 34.99 },
  { asin: "B09B8V1LZ3", title: "Logitech MX Master 3S Wireless Performance Mouse - Graphite", image: "https://images.unsplash.com/photo-1527864550417-7fd91fc51a46?w=200&h=200&fit=crop&auto=format", current: 84.5, buyBox: null },
  { asin: "B07H8QMZWV", title: "Instant Pot Duo 7-in-1 Electric Pressure Cooker, 6 Quart, Stainless Steel", image: "https://images.unsplash.com/photo-1585515320310-259814833e62?w=200&h=200&fit=crop&auto=format", current: 79.95, buyBox: 84.99 },
  { asin: "B0BSHF7WHW", title: "Stanley Quencher H2.0 FlowState Stainless Steel Tumbler 40 oz", image: "https://images.unsplash.com/photo-1602143407151-7111542de6e8?w=200&h=200&fit=crop&auto=format", current: 44.99, buyBox: null },
  { asin: "B0CHX3QBCH", title: "Sony WH-1000XM5 Wireless Noise Canceling Headphones - Black", image: "https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=200&h=200&fit=crop&auto=format", current: 329.99, buyBox: 349.0 },
  { asin: "B0CJM1GZP2", title: "Nintendo Switch OLED Model with White Joy-Con", image: "https://images.unsplash.com/photo-1612036782180-6f0b6cd846fe?w=200&h=200&fit=crop&auto=format", current: 339.0, buyBox: null },
  { asin: "B0B3C2R8MP", title: "LEGO Star Wars The Mandalorian's N-1 Starfighter Building Kit 75325", image: "https://images.unsplash.com/photo-1587654780291-39c9404d746b?w=200&h=200&fit=crop&auto=format", current: 59.99, buyBox: 64.99 },
  { asin: "B09LH5SBPS", title: "OLAPLEX No. 3 Hair Perfector Repairing Treatment, 3.3 Fl Oz", image: "https://images.unsplash.com/photo-1556228720-195a672e8a03?w=200&h=200&fit=crop&auto=format", current: 26.49, buyBox: null },
  { asin: "B07FZ8S74R", title: "Crocs Unisex-Adult Classic Clogs", image: "https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=200&h=200&fit=crop&auto=format", current: 39.99, buyBox: 44.99 },
  { asin: "B0BDHWDR12", title: "Hydro Flask Standard Mouth Bottle with Flex Cap, 21 oz", image: "https://images.unsplash.com/photo-1523362628745-0c100150b504?w=200&h=200&fit=crop&auto=format", current: 32.95, buyBox: null },
  { asin: "B08J65DST5", title: "Ring Video Doorbell - 1080p HD, Two-Way Talk, Wired", image: "https://images.unsplash.com/photo-1558002038-1055907df827?w=200&h=200&fit=crop&auto=format", current: 54.99, buyBox: 59.99 },
  { asin: "B0C7BZ4FPK", title: "Owala FreeSip Insulated Stainless Steel Water Bottle, 24 oz", image: "https://images.unsplash.com/photo-1610824352934-c10d87b700cc?w=200&h=200&fit=crop&auto=format", current: 27.99, buyBox: null },
  { asin: "B0BDJ5BPQR", title: "Kindle Paperwhite (16 GB) – 6.8\" display, adjustable warm light", image: "https://images.unsplash.com/photo-1592496431122-2349e0fbc666?w=200&h=200&fit=crop&auto=format", current: 139.99, buyBox: 149.99 },
  { asin: "B09JQMJSXY", title: "Anker Portable Charger, 325 PowerCore Essential 20K mAh", image: "https://images.unsplash.com/photo-1609091839311-d5365f9ff1c5?w=200&h=200&fit=crop&auto=format", current: 39.99, buyBox: null },
  { asin: "B07PXGQC1Q", title: "Bose QuietComfort 45 Bluetooth Wireless Headphones - Triple Black", image: "https://images.unsplash.com/photo-1583394838336-acd977736f90?w=200&h=200&fit=crop&auto=format", current: 249.0, buyBox: 279.0 },
  { asin: "B0B7BP6CJN", title: "Pokémon TCG: Scarlet & Violet Booster Box (36 Packs)", image: "https://images.unsplash.com/photo-1647964937330-52f08eaa50fe?w=200&h=200&fit=crop&auto=format", current: 119.99, buyBox: null },
  { asin: "B08H75RTZ8", title: "Yeti Rambler 20 oz Tumbler with MagSlider Lid - Stainless Steel", image: "https://images.unsplash.com/photo-1571683108049-3eb3eaf2cc1e?w=200&h=200&fit=crop&auto=format", current: 35.0, buyBox: 38.0 },
  { asin: "B09G9D8KRQ", title: "Apple Watch Series 9 [GPS 41mm] Smartwatch with Midnight Aluminum Case", image: "https://images.unsplash.com/photo-1546868871-7041f2a55e12?w=200&h=200&fit=crop&auto=format", current: 329.0, buyBox: null },
  { asin: "B0BVP7Q9LX", title: "Cosrx Snail 96 Mucin Power Repairing Essence 3.38 fl.oz", image: "https://images.unsplash.com/photo-1571781926291-c477ebfd024b?w=200&h=200&fit=crop&auto=format", current: 17.99, buyBox: 19.99 },
  { asin: "B07ZPKBL9V", title: "Ninja AF101 Air Fryer, 4 Quart Capacity, Black/Grey", image: "https://images.unsplash.com/photo-1626806787461-102c1bfaaea1?w=200&h=200&fit=crop&auto=format", current: 99.99, buyBox: null },
  { asin: "B08F7N8PDP", title: "Roku Streaming Stick 4K | Streaming Device 4K/HDR/Dolby Vision", image: "https://images.unsplash.com/photo-1593305841991-05c297ba4575?w=200&h=200&fit=crop&auto=format", current: 39.0, buyBox: 49.99 },
  { asin: "B0CQM73PFB", title: "Magic: The Gathering Foundations Play Booster Box - 36 Packs", image: "https://images.unsplash.com/photo-1606503153255-59d8b8b1b6a4?w=200&h=200&fit=crop&auto=format", current: 144.99, buyBox: null },
  { asin: "B08PP5MSVB", title: "Fitbit Charge 6 Fitness Tracker with GPS, Heart Rate, Sleep Tracking", image: "https://images.unsplash.com/photo-1575311373937-040b8e1fd5b6?w=200&h=200&fit=crop&auto=format", current: 99.95, buyBox: 109.95 },
];

const initialSeed: DemoItem[] = productPool.slice(0, 6).map((p, i) => ({
  ...p,
  id: `seed-${i}`,
  evaluatedAt: Date.now() - (10_000 + i * 2_000),
  actionAt: Date.now() - (10_000 + i * 2_000),
  actionType: i === 0 ? "price_changed" : "no_change",
}));

const seed: DemoItem[] = initialSeed;

function formatRelative(ts: number, now: number) {
  const diff = Math.max(0, Math.floor((now - ts) / 1000));
  if (diff < 60) return `${diff}s ago`;
  const m = Math.floor(diff / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
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
  if (a === "protected") return "Floor Protected";
  return "Holding";
};

const getDetails = (item: DemoItem) => {
  const anchor = item.buyBox != null ? `Buy Box $${item.buyBox.toFixed(2)}` : "Lowest FBA (no Buy Box)";
  const roiFloor = +(item.current * 0.86).toFixed(2);
  const vsFloorPct = Math.round(((item.current - roiFloor) / roiFloor) * 100);

  if (item.actionType === "price_changed") {
    const undercut = item.buyBox != null && item.current < item.buyBox;
    return {
      reason: undercut
        ? `🧠 AI validated the price reduction to win the Buy Box`
        : "🧠 AI validated the price adjustment to compete for sales",
      anchor,
      strategy: "AI_WIN_SALES_BOOSTER",
      roiFloor,
      vsFloorPct,
      guards: "none",
    };
  }
  if (item.actionType === "protected") {
    return {
      reason: "🧠 AI held — below profitable threshold",
      anchor,
      strategy: "FLOOR_PROTECTION_GUARD",
      roiFloor,
      vsFloorPct,
      guards: "min_roi_floor, manual_min_price",
    };
  }
  return {
    reason: "🧠 AI confirmed the engine's decision — no change needed",
    anchor,
    strategy: "DEFENSIVE_HOLD",
    roiFloor,
    vsFloorPct,
    guards: "cluster_match",
  };
};

const LiveAiDemoCompactThemed = () => {
  const [items, setItems] = useState<DemoItem[]>(seed);
  const [now, setNow] = useState(Date.now());
  const [nextRunAt, setNextRunAt] = useState(Date.now() + 1_000);
  const [lastRunAt, setLastRunAt] = useState(Date.now() - 5_000);
  const [refreshedAt, setRefreshedAt] = useState(Date.now() - 5_000);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const [stats, setStats] = useState({
    total: 140,
    bbLost: 14,
    raised: 84,
    constrained: 12,
    winners: 126,
  });

  const cycleRef = useRef({ poolIndex: 6, startedAt: Date.now() });

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    const TICK_MS = 6000;

    const t = window.setInterval(() => {
      setItems((prev) => {
        const tsNow = Date.now();
        const cyc = cycleRef.current;

        if (tsNow - cyc.startedAt > 60 * 60 * 1000) {
          cyc.poolIndex = 0;
          cyc.startedAt = tsNow;
        }

        const introduceNew = Math.random() < 0.7;
        let newItem: DemoItem;
        let priorPrice: number;
        let nextList: DemoItem[];

        if (introduceNew) {
          const product = productPool[cyc.poolIndex % productPool.length];
          cyc.poolIndex += 1;
          const roll = Math.random();
          let actionType: DemoItem["actionType"] = "no_change";
          let price = product.current;
          if (roll < 0.4) {
            actionType = "price_changed";
            const delta = +(Math.random() * 0.5 - 0.05).toFixed(2);
            price = Math.max(1, +(product.current + delta).toFixed(2));
          } else if (roll >= 0.85) {
            actionType = "protected";
          }
          newItem = {
            ...product,
            id: `${product.asin}-${tsNow}`,
            current: price,
            evaluatedAt: tsNow,
            actionAt: tsNow,
            actionType,
            flash: tsNow,
          };
          priorPrice = product.current;
          nextList = [newItem, ...prev].slice(0, 6);
        } else {
          const idx = Math.floor(Math.random() * prev.length);
          const cur = prev[idx];
          const roll = Math.random();
          let actionType: DemoItem["actionType"] = "no_change";
          let price = cur.current;
          const newBB =
            cur.buyBox === null
              ? null
              : Math.max(0.5, +(cur.buyBox + (Math.random() - 0.5) * 0.4).toFixed(2));
          if (roll < 0.4) {
            actionType = "price_changed";
            const delta = +(Math.random() * 0.5 - 0.05).toFixed(2);
            price = Math.max(1, +(cur.current + delta).toFixed(2));
          } else if (roll >= 0.85) {
            actionType = "protected";
          }
          newItem = {
            ...cur,
            current: price,
            buyBox: newBB,
            evaluatedAt: tsNow,
            actionAt: tsNow,
            actionType,
            flash: tsNow,
          };
          priorPrice = cur.current;
          const without = prev.filter((_, i) => i !== idx);
          nextList = [newItem, ...without];
        }

        setStats((s) => ({
          total: s.total + 1,
          bbLost: s.bbLost + (Math.random() < 0.1 ? 1 : 0),
          raised:
            s.raised +
            (newItem.actionType === "price_changed" && newItem.current > priorPrice ? 1 : 0),
          constrained: s.constrained + (newItem.actionType === "protected" ? 1 : 0),
          winners: s.winners + (Math.random() < 0.9 ? 1 : 0),
        }));

        return nextList;
      });
      setLastRunAt(Date.now());
      setRefreshedAt(Date.now());
      setNextRunAt(Date.now() + 90_000 + Math.floor(Math.random() * 60_000));
    }, TICK_MS);
    return () => window.clearInterval(t);
  }, []);

  const lastRunRel = useMemo(() => formatRelative(lastRunAt, now), [lastRunAt, now]);
  const nextRunRel = useMemo(() => formatCountdown(nextRunAt, now), [nextRunAt, now]);
  const refreshedRel = useMemo(() => formatRelative(refreshedAt, now), [refreshedAt, now]);

  return (
    <div className="rounded-2xl border border-border bg-card/90 shadow-xl backdrop-blur-xl overflow-hidden">
      {/* Top header — Live AI in Action */}
      <div className="px-4 pt-4 pb-3 border-b border-border">
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/15 ring-1 ring-primary/30">
            <Brain className="h-4 w-4 text-primary" />
          </div>
          <div className="min-w-0">
            <p className="font-ih-display text-sm font-semibold text-foreground leading-tight truncate">
              Live AI in Action
            </p>
            <p className="text-[10px] text-muted-foreground leading-tight truncate">
              Every pricing decision is executed by your engine — and reviewed by Gemini AI.
            </p>
          </div>
        </div>
      </div>

      {/* Compact single-line status */}
      <div className="px-4 py-3 border-b border-border bg-muted/30">
        <div className="flex items-center gap-3 text-sm text-muted-foreground flex-wrap">
          <span className="relative flex h-2.5 w-2.5 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-75" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
          </span>
          <span className="font-semibold text-emerald-700">Live</span>
          <span className="text-muted-foreground/50">·</span>
          <span className="tabular-nums text-muted-foreground">Updated {lastRunRel}</span>
          <span className="text-muted-foreground/50">·</span>
          <span className="tabular-nums text-muted-foreground">Next check ~{nextRunRel}</span>
          <span className="text-muted-foreground/50">·</span>
          <span className="inline-flex items-center gap-2 text-base font-semibold text-primary">
            <Brain className="h-5 w-5" />
            Gemini AI continuously reviewing decisions to improve outcomes
          </span>
        </div>
      </div>

      {/* Live feed — 3 columns × 2 rows like the real AI panel */}
      <div className="px-3 pt-2.5">
        <p className="text-[9px] uppercase tracking-wider text-muted-foreground">Simulation</p>
      </div>
      <div className="px-3 pt-2 pb-3 grid grid-cols-3 gap-2 max-h-[420px] overflow-hidden">
        {items.slice(0, 6).map((item) => {
          const flashing = item.flash && now - item.flash < 1500;
          const isExpanded = expandedId === item.id;
          const details = getDetails(item);
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setExpandedId(isExpanded ? null : item.id)}
              className={cn(
                "text-left rounded-xl border border-border bg-muted/30 p-2.5 transition-all duration-500 cursor-pointer",
                flashing
                  ? "ring-2 ring-primary/50 shadow-[0_0_20px_-5px_hsl(var(--primary)/0.4)]"
                  : "hover:border-primary/30",
                isExpanded && "ring-1 ring-primary/30 bg-muted/50"
              )}
            >
              <div className="flex items-start gap-2 mb-1.5">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-white overflow-hidden">
                  <img
                    src={item.image}
                    alt=""
                    loading="lazy"
                    onError={(e) => {
                      (e.currentTarget as HTMLImageElement).style.display = "none";
                      const fallback = e.currentTarget.nextElementSibling as HTMLElement | null;
                      if (fallback) fallback.style.display = "flex";
                    }}
                    className="h-full w-full object-contain"
                  />
                  <div className="hidden h-full w-full items-center justify-center bg-gradient-to-br from-primary/20 to-purple-500/10">
                    <Activity className="h-3 w-3 text-primary" />
                  </div>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <p className="line-clamp-1 text-[10px] font-medium text-foreground leading-tight flex-1 min-w-0">
                      {item.title}
                    </p>
                    <ChevronDown
                      className={cn(
                        "h-3 w-3 shrink-0 text-muted-foreground transition-transform",
                        isExpanded && "rotate-180 text-primary"
                      )}
                    />
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
                    <span className="font-mono text-[9px] text-muted-foreground">{item.asin}</span>
                    <span
                      className={cn(
                        "inline-flex items-center rounded-full border px-1.5 py-0 text-[9px] font-medium",
                        item.actionType === "price_changed" &&
                          "border-primary/40 bg-primary/15 text-primary",
                        item.actionType === "protected" &&
                          "border-emerald-400/40 bg-emerald-400/10 text-emerald-700",
                        item.actionType === "no_change" &&
                          "border-border bg-muted text-muted-foreground"
                      )}
                    >
                      {getLabel(item.actionType)}
                    </span>
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between gap-2">
                <div className="flex items-baseline gap-3">
                  <div>
                    <span className="text-[9px] uppercase tracking-wider text-muted-foreground">
                      Current{" "}
                    </span>
                    <span
                      className={cn(
                        "font-ih-display text-sm font-semibold tabular-nums",
                        flashing ? "text-primary" : "text-foreground"
                      )}
                    >
                      ${item.current.toFixed(2)}
                    </span>
                  </div>
                  <div>
                    <span className="text-[9px] uppercase tracking-wider text-muted-foreground">
                      Buy Box{" "}
                    </span>
                    <span className="font-ih-display text-sm font-semibold tabular-nums text-muted-foreground">
                      {item.buyBox === null ? "—" : `$${item.buyBox.toFixed(2)}`}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                  <Clock3 className="h-3 w-3" />
                  <span>{formatRelative(item.evaluatedAt, now)}</span>
                </div>
              </div>

              <p className="mt-1 text-[9px] text-muted-foreground leading-tight line-clamp-1">
                {item.actionType === "price_changed"
                  ? "🧠 AI reduced price to win Buy Box while staying profitable"
                  : item.actionType === "protected"
                  ? "🧠 AI held — below profitable threshold"
                  : "🧠 AI confirmed optimal position — no change needed"}
              </p>

              {/* Expanded details — same depth as the historical AI Insights view */}
              {isExpanded && (
                <div className="mt-2 pt-2 border-t border-border space-y-1.5 animate-in fade-in slide-in-from-top-1 duration-200">
                  <div className="flex items-start gap-1.5">
                    <span className="text-[8px] uppercase tracking-wider text-muted-foreground w-14 shrink-0 mt-0.5">Reason</span>
                    <span className="text-[10px] text-foreground leading-tight">{details.reason}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[8px] uppercase tracking-wider text-muted-foreground w-14 shrink-0">Anchor</span>
                    <span className="text-[10px] text-muted-foreground">{details.anchor}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[8px] uppercase tracking-wider text-muted-foreground w-14 shrink-0">Strategy</span>
                    <span className="font-mono text-[9px] text-primary">{details.strategy}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[8px] uppercase tracking-wider text-muted-foreground w-14 shrink-0">ROI floor</span>
                    <span className="text-[10px] text-muted-foreground tabular-nums">
                      ${details.roiFloor.toFixed(2)}
                      <span className={cn(
                        "ml-1.5 text-[9px]",
                        details.vsFloorPct >= 0 ? "text-emerald-700" : "text-rose-700"
                      )}>
                        {details.vsFloorPct >= 0 ? "+" : ""}{details.vsFloorPct}% vs current
                      </span>
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[8px] uppercase tracking-wider text-muted-foreground w-14 shrink-0">Guards</span>
                    <span className="font-mono text-[9px] text-muted-foreground">{details.guards}</span>
                  </div>
                </div>
              )}
            </button>
          );
        })}
      </div>

      {/* Gemini AI attribution line */}
      <div className="px-4 py-3.5 border-t border-primary/20 bg-gradient-to-r from-primary/10 via-purple-500/5 to-primary/10">
        <div className="flex items-center justify-center gap-2.5 text-sm md:text-base font-semibold text-primary text-center">
          <Brain className="h-5 w-5 md:h-6 md:w-6 flex-shrink-0" />
          <span>Select decisions are reviewed by <span className="text-foreground">Gemini 2.5 Flash</span> and <span className="text-foreground">Gemini 2.5 Pro</span> (deep analysis)</span>
        </div>
      </div>

      {/* Stats footer */}
      <div className="border-t border-border bg-muted/30 px-3 py-2.5">
        <div className="grid grid-cols-5 gap-1.5">
          <div className="text-center">
            <p className="font-ih-display text-base font-bold text-foreground tabular-nums leading-none">
              {stats.total}
            </p>
            <p className="text-[8px] text-muted-foreground mt-0.5 leading-tight">Total Evaluations</p>
          </div>
          <div className="text-center">
            <p className="font-ih-display text-base font-bold text-rose-600 tabular-nums leading-none">
              {stats.bbLost}
            </p>
            <p className="text-[8px] text-muted-foreground mt-0.5 leading-tight">Buy Box Lost Events</p>
          </div>
          <div className="text-center">
            <p className="font-ih-display text-base font-bold text-primary tabular-nums leading-none">
              {stats.raised}
            </p>
            <p className="text-[8px] text-muted-foreground mt-0.5 leading-tight">Prices Raised</p>
          </div>
          <div className="text-center">
            <p className="font-ih-display text-base font-bold text-amber-600 tabular-nums leading-none">
              {stats.constrained}
            </p>
            <p className="text-[8px] text-muted-foreground mt-0.5 leading-tight">Safety Protections</p>
          </div>
          <div className="text-center">
            <p className="font-ih-display text-base font-bold text-emerald-600 tabular-nums leading-none">
              {stats.winners}
            </p>
            <p className="text-[8px] text-muted-foreground mt-0.5 leading-tight">Winning Positions</p>
          </div>
        </div>
        <p className="mt-2 pt-2 border-t border-border text-center text-[9px] text-muted-foreground">
          Driven by real-time data + Gemini AI review
        </p>
      </div>
    </div>
  );
};

export default LiveAiDemoCompactThemed;
