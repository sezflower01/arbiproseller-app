import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CheckCircle, Clock, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { FixDataQualityButton } from "./FixDataQualityButton";

interface DataHealthPanelProps {
  userId: string;
  dateRange: { startDate: string; endDate: string } | null;
  session?: { access_token: string } | null;
  dateFilter?: string;
  targetDate?: string;
  onDataFixed?: () => void;
  className?: string;
}

export function DataHealthPanel({ userId, dateRange, session, dateFilter, targetDate, onDataFixed, className }: DataHealthPanelProps) {
  const [lastBackfillTime, setLastBackfillTime] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const lastFetchedUserId = useRef<string | null>(null);

  useEffect(() => {
    if (!userId || lastFetchedUserId.current === userId) return;
    lastFetchedUserId.current = userId;

    let cancelled = false;
    const fetchCacheTime = async () => {
      setLoading(true);
      try {
        const { data } = await supabase
          .from('asin_fee_cache')
          .select('updated_at')
          .eq('user_id', userId)
          .order('updated_at', { ascending: false })
          .limit(1);

        if (!cancelled) {
          setLastBackfillTime(data?.[0]?.updated_at ?? null);
        }
      } catch (err) {
        console.error('Error fetching health stats:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchCacheTime();
    return () => { cancelled = true; };
  }, [userId]);

  const formatTime = (isoString: string | null) => {
    if (!isoString) return 'Never';
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    return date.toLocaleDateString();
  };

  return (
    <Card className={cn("border-dashed border-muted", className)}>
      <CardContent className="py-3 px-4">
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <div className="flex items-center gap-1.5">
            <CheckCircle className="h-4 w-4 text-primary" />
            <span className="font-medium text-muted-foreground">Data Health</span>
          </div>

          {loading ? (
            <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : (
            <>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Clock className="h-3 w-3" />
                Last fee cache: {formatTime(lastBackfillTime)}
              </div>
              <Badge variant="secondary" className="text-xs">
                NULL fees enforced
              </Badge>
            </>
          )}

          <div className="ml-auto">
            <FixDataQualityButton
              userId={userId}
              dateFilter={dateFilter || 'today'}
              targetDate={targetDate}
              session={session || null}
              onComplete={onDataFixed || (() => {})}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default DataHealthPanel;
