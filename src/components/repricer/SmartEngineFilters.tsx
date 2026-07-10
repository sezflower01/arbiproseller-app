import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TrendingDown, TrendingUp, Minus, Shield, AlertTriangle, DollarSign } from "lucide-react";

export type FilterType = "all" | "bb_loss" | "raised" | "profit_extract" | "constrained" | "floor_hit" | "needs_review";
export type SortType = "importance" | "needs_review" | "price_gap" | "recent";

const FILTERS: { id: FilterType; label: string; icon?: React.ReactNode; color: string }[] = [
  { id: "all", label: "All", color: "bg-muted text-foreground" },
  { id: "bb_loss", label: "BB Loss", icon: <TrendingDown className="h-3 w-3" />, color: "bg-destructive/10 text-destructive" },
  { id: "raised", label: "Raised", icon: <TrendingUp className="h-3 w-3" />, color: "bg-green-500/10 text-green-700 dark:text-green-400" },
  { id: "profit_extract", label: "Profit Extract", icon: <DollarSign className="h-3 w-3" />, color: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" },
  { id: "constrained", label: "Held", icon: <Minus className="h-3 w-3" />, color: "bg-muted text-muted-foreground" },
  { id: "floor_hit", label: "Floor Held", icon: <Shield className="h-3 w-3" />, color: "bg-amber-500/10 text-amber-700 dark:text-amber-400" },
  { id: "needs_review", label: "Needs Review", icon: <AlertTriangle className="h-3 w-3" />, color: "bg-red-500/10 text-red-700 dark:text-red-400" },
];

interface SmartEngineFiltersProps {
  activeFilter: FilterType;
  onFilterChange: (f: FilterType) => void;
  activeSort: SortType;
  onSortChange: (s: SortType) => void;
  counts: Record<string, number>;
}

export default function SmartEngineFilters({ activeFilter, onFilterChange, activeSort, onSortChange, counts }: SmartEngineFiltersProps) {
  return (
    <div className="flex items-center justify-between gap-3 flex-wrap">
      <div className="flex items-center gap-1.5 flex-wrap">
        {FILTERS.map(f => {
          const count = f.id === "all" ? counts.total : (counts[f.id] ?? 0);
          const isActive = activeFilter === f.id;
          return (
            <button
              key={f.id}
              onClick={() => onFilterChange(f.id)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all ${
                isActive ? `${f.color} ring-2 ring-primary/30` : "bg-muted/40 text-muted-foreground hover:bg-muted/60"
              }`}
            >
              {f.icon}
              {f.label}
              {count > 0 && (
                <span className={`ml-0.5 text-[10px] ${isActive ? "opacity-80" : "opacity-60"}`}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <Select value={activeSort} onValueChange={(v) => onSortChange(v as SortType)}>
        <SelectTrigger className="w-[160px] h-8 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="importance">Most important</SelectItem>
          <SelectItem value="needs_review">Needs review first</SelectItem>
          <SelectItem value="price_gap">Biggest price gap</SelectItem>
          <SelectItem value="recent">Most recent</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
