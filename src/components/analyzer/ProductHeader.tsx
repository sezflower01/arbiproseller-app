import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ExternalLink } from "lucide-react";
import type { AnalyzerSnapshot } from "@/hooks/use-analyzer-snapshot";

interface Props {
  snap: AnalyzerSnapshot;
}

export default function ProductHeader({ snap }: Props) {
  const { identity, asin, marketplace } = snap;
  const amazonUrl = `https://www.amazon.${marketplace === "US" ? "com" : marketplace.toLowerCase()}/dp/${asin}`;

  return (
    <Card className="sticky top-2 z-10 shadow-md">
      <CardContent className="p-4">
        <div className="flex gap-4 items-start">
          {identity.image ? (
            <img
              src={identity.image}
              alt={identity.title ?? asin}
              className="min-w-[96px] w-24 h-24 object-contain rounded-md border bg-background"
            />
          ) : (
            <div className="min-w-[96px] w-24 h-24 rounded-md border bg-muted" />
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h1 className="text-base sm:text-lg font-semibold leading-snug truncate">
                  {identity.title ?? "—"}
                </h1>
                <p className="text-xs text-muted-foreground mt-0.5 truncate">
                  {identity.brand ?? "Unknown brand"} · {identity.category ?? "—"}
                </p>
                <div className="flex items-center gap-2 mt-2 flex-wrap">
                  <Badge variant="outline" className="font-mono">{asin}</Badge>
                  <Badge variant="secondary">{marketplace}</Badge>
                  {identity.rating != null && (
                    <span className="text-xs text-muted-foreground">
                      ★ {identity.rating.toFixed(1)} · {identity.reviewCount?.toLocaleString() ?? 0} reviews
                    </span>
                  )}
                </div>
              </div>
              <a
                href={amazonUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline whitespace-nowrap"
              >
                Open on Amazon <ExternalLink className="w-3 h-3" />
              </a>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
