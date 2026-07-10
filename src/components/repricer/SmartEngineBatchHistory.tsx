import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Clock, Loader2, Zap } from "lucide-react";
import { format } from "date-fns";

interface SmartEngineBatchHistoryProps {
  batches: any[];
  loadingBatchId: string | null;
  onLoadBatch: (batchId: string, meta: any) => void;
}

export default function SmartEngineBatchHistory({ batches, loadingBatchId, onLoadBatch }: SmartEngineBatchHistoryProps) {
  if (batches.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Clock className="h-4 w-4 text-muted-foreground" />
          Recent Batches
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-1.5">
          {batches.map(b => (
            <button
              key={b.id}
              onClick={() => onLoadBatch(b.id, b)}
              disabled={loadingBatchId === b.id}
              className="w-full flex items-center justify-between text-xs py-2 px-3 rounded bg-muted/30 hover:bg-muted/60 transition-colors cursor-pointer text-left"
            >
              <div className="flex items-center gap-2">
                {loadingBatchId === b.id ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : b.trigger_type === "automated" ? (
                  <Badge variant="outline" className="text-[9px] gap-1">
                    <Zap className="h-2.5 w-2.5" /> Auto
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="text-[9px] gap-1">
                    Manual
                  </Badge>
                )}
                <span className="text-muted-foreground">
                  {format(new Date(b.created_at), "MMM d, h:mm a")}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <span>{b.asin_count} ASINs</span>
                <span className="text-green-600">{b.optimal_count} optimal</span>
                {b.review_needed_count > 0 && (
                  <span className="text-red-500">{b.review_needed_count} review</span>
                )}
                <span className="text-muted-foreground">→</span>
              </div>
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
