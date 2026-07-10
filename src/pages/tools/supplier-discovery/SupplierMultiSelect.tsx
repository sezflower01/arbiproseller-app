import { useMemo, useState } from "react";
import { Check, ChevronDown, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Supplier, normalizeDomain } from "./shared";

interface SupplierMultiSelectProps {
  suppliers: Supplier[];
  selectedDomains: string[];
  onChange: (domains: string[]) => void;
  disabled?: boolean;
}

/**
 * Multi-select dropdown that lets the user pick a subset of their supplier
 * registry to scope a discovery search. When nothing is selected, the parent
 * component should treat it as "no explicit subset" (use registry defaults
 * or the broader trusted-only toggle).
 */
const SupplierMultiSelect = ({
  suppliers,
  selectedDomains,
  onChange,
  disabled,
}: SupplierMultiSelectProps) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const normalizedSuppliers = useMemo(() => {
    const seen = new Set<string>();
    const out: { domain: string; name: string | null; trust: string | null }[] = [];
    for (const s of suppliers) {
      const dom = normalizeDomain(s.domain);
      if (!dom || seen.has(dom)) continue;
      seen.add(dom);
      out.push({
        domain: dom,
        name: (s as any).display_name || (s as any).name || null,
        trust: (s as any).trust_level || null,
      });
    }
    return out.sort((a, b) => a.domain.localeCompare(b.domain));
  }, [suppliers]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return normalizedSuppliers;
    return normalizedSuppliers.filter(
      (s) =>
        s.domain.toLowerCase().includes(q) ||
        (s.name?.toLowerCase().includes(q) ?? false),
    );
  }, [normalizedSuppliers, query]);

  const selectedSet = useMemo(() => new Set(selectedDomains), [selectedDomains]);

  const toggle = (domain: string) => {
    const next = new Set(selectedSet);
    if (next.has(domain)) next.delete(domain);
    else next.add(domain);
    onChange([...next]);
  };

  const selectAll = () => onChange(filtered.map((s) => s.domain));
  const clearAll = () => onChange([]);

  const selectedCount = selectedDomains.length;
  const totalCount = normalizedSuppliers.length;

  const triggerLabel = selectedCount === 0
    ? `Search in: all my suppliers (${totalCount})`
    : `Search in: ${selectedCount} of ${totalCount} supplier${selectedCount === 1 ? "" : "s"}`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || totalCount === 0}
          className="h-8 justify-between gap-2 min-w-[260px] text-xs"
        >
          <span className="truncate">{triggerLabel}</span>
          <ChevronDown className="h-3 w-3 opacity-60 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[320px] p-0" align="start">
        <div className="p-2 border-b border-border/50">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter suppliers…"
              className="pl-7 h-8 text-xs"
            />
            {query && (
              <button
                onClick={() => setQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label="Clear filter"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
          <div className="flex items-center justify-between mt-2 text-xs">
            <button
              type="button"
              onClick={selectAll}
              className="text-primary hover:underline"
              disabled={filtered.length === 0}
            >
              Select all{query ? " (filtered)" : ""}
            </button>
            <button
              type="button"
              onClick={clearAll}
              className="text-muted-foreground hover:text-foreground"
              disabled={selectedCount === 0}
            >
              Clear
            </button>
          </div>
        </div>

        <ScrollArea className="h-[280px]">
          <div className="p-1">
            {filtered.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                {totalCount === 0 ? "No suppliers in your registry yet." : "No match."}
              </div>
            ) : (
              filtered.map((s) => {
                const checked = selectedSet.has(s.domain);
                return (
                  <button
                    key={s.domain}
                    type="button"
                    onClick={() => toggle(s.domain)}
                    className={cn(
                      "w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-xs hover:bg-accent transition-colors",
                      checked && "bg-accent/60",
                    )}
                  >
                    <span
                      className={cn(
                        "h-4 w-4 rounded border flex items-center justify-center shrink-0",
                        checked
                          ? "bg-primary border-primary text-primary-foreground"
                          : "border-input bg-background",
                      )}
                    >
                      {checked && <Check className="h-3 w-3" />}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="font-mono truncate text-foreground">{s.domain}</div>
                      {s.name && (
                        <div className="text-muted-foreground truncate text-[10px]">{s.name}</div>
                      )}
                    </div>
                    {s.trust && (
                      <Badge variant="outline" className="text-[9px] py-0 px-1 h-4 capitalize">
                        {s.trust}
                      </Badge>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </ScrollArea>

        <div className="p-2 border-t border-border/50 flex items-center justify-between text-[11px] text-muted-foreground">
          <span>
            {selectedCount === 0
              ? "All suppliers will be searched"
              : `${selectedCount} selected`}
          </span>
          <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => setOpen(false)}>
            Done
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
};

export default SupplierMultiSelect;
