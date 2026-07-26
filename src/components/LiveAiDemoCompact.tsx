import { Brain } from "lucide-react";

// Lightweight "Live AI in Action" indicator. Previously this rendered a
// simulated feed of fake per-ASIN price decisions with fabricated stats
// (Total Evaluations, Buy Box Lost Events, etc.) ticking in real time --
// removed because it read as real activity when it wasn't, which undercuts
// the "proven, not assumed" trust story used elsewhere on this page. This
// keeps only true claims: the engine runs live, and Gemini reviews decisions.
const LiveAiDemoCompact = () => {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 shadow-2xl backdrop-blur-xl overflow-hidden">
      <div className="px-4 pt-4 pb-3 border-b border-white/5">
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/15 ring-1 ring-primary/30">
            <Brain className="h-4 w-4 text-primary" />
          </div>
          <div className="min-w-0">
            <p className="font-display text-sm font-semibold text-white leading-tight truncate">
              Live AI in Action
            </p>
            <p className="text-[10px] text-muted-foreground leading-tight truncate">
              Every pricing decision is executed by your engine.
            </p>
          </div>
        </div>
      </div>

      <div className="px-4 py-4 flex items-center gap-3 text-sm text-muted-foreground flex-wrap">
        <span className="relative flex h-2.5 w-2.5 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-400" />
        </span>
        <span className="font-semibold text-emerald-300">Live</span>
        <span className="text-gray-500">·</span>
        <span>Actively monitoring your listings</span>
      </div>

      <div className="px-4 py-3.5 border-t border-primary/20 bg-gradient-to-r from-primary/10 via-purple-500/5 to-primary/10">
        <div className="flex items-center justify-center gap-2.5 text-sm md:text-base font-semibold text-primary text-center">
          <Brain className="h-5 w-5 md:h-6 md:w-6 flex-shrink-0" />
          <span>Select decisions are reviewed by <span className="text-white">Gemini 2.5 Flash</span> and <span className="text-white">Gemini 2.5 Pro</span> (deep analysis)</span>
        </div>
      </div>
    </div>
  );
};

export default LiveAiDemoCompact;
