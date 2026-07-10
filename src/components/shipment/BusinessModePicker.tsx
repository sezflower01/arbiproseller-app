import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Check, ShoppingBag, Package, Layers, Building2 } from "lucide-react";
import { BUSINESS_MODES, type ShipmentBusinessMode } from "@/lib/shipment/businessMode";
import { cn } from "@/lib/utils";

const ICONS: Record<ShipmentBusinessMode, React.ComponentType<{ className?: string }>> = {
  oa: ShoppingBag,
  wholesale: Package,
  hybrid: Layers,
  prep_center: Building2,
};

interface Props {
  value: ShipmentBusinessMode;
  onChange: (mode: ShipmentBusinessMode) => void;
  compact?: boolean;
}

export default function BusinessModePicker({ value, onChange, compact = false }: Props) {
  return (
    <div className={cn("grid gap-3", compact ? "md:grid-cols-2" : "md:grid-cols-2 xl:grid-cols-4")}>
      {BUSINESS_MODES.map((m) => {
        const Icon = ICONS[m.id];
        const selected = value === m.id;
        return (
          <button
            key={m.id}
            type="button"
            onClick={() => onChange(m.id)}
            className="text-left"
          >
            <Card
              className={cn(
                "p-4 h-full transition-all border-2 cursor-pointer relative",
                selected
                  ? "border-primary bg-primary/5 shadow-md"
                  : "border-border hover:border-primary/40 hover:bg-muted/40",
              )}
            >
              {selected && (
                <Badge className="absolute top-2 right-2 bg-primary text-primary-foreground">
                  <Check className="h-3 w-3 mr-1" /> Selected
                </Badge>
              )}
              {m.id === "oa" && !selected && (
                <Badge variant="outline" className="absolute top-2 right-2 text-[10px]">
                  Default
                </Badge>
              )}
              <div className="flex items-start gap-3">
                <div className={cn("rounded-lg p-2", selected ? "bg-primary/15 text-primary" : "bg-muted text-foreground/70")}>
                  <Icon className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <div className="font-semibold">{m.label}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{m.tagline}</div>
                </div>
              </div>
              <p className="text-xs text-muted-foreground mt-3">{m.description}</p>
              <ul className="mt-3 space-y-1">
                {m.bullets.map((b) => (
                  <li key={b} className="text-xs flex items-start gap-1.5">
                    <Check className="h-3 w-3 mt-0.5 text-primary shrink-0" />
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
            </Card>
          </button>
        );
      })}
    </div>
  );
}
