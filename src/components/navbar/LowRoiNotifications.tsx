import { useState, useEffect, useRef } from "react";
import { Bell, Copy, Check, EyeOff, Eye } from "lucide-react";
import { useNavigate } from "react-router-dom";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { isQueryCircuitOpen, isTimeoutError, recordDbFailure, recordDbSuccess, getBackoffMultiplier } from "@/hooks/use-db-pressure";

interface RoiAlertRow {
  id: string;
  asin: string;
  title: string | null;
  order_date: string;
  units: number;
  roi: number;
  status: string;
  seen: boolean;
  ignored: boolean;
}

interface LowRoiAlert {
  id: string;
  asin: string;
  title: string | null;
  roi: number;
  order_date: string;
  units: number;
  ignored: boolean;
}

const DEFAULT_LOW_ROI_THRESHOLD = 20;

export default function LowRoiNotifications() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [alerts, setAlerts] = useState<LowRoiAlert[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [seenIds, setSeenIds] = useState<Set<string>>(new Set());
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [roiThreshold, setRoiThreshold] = useState(DEFAULT_LOW_ROI_THRESHOLD);

  const handleCopyAsin = async (e: React.MouseEvent, asin: string, id: string) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(asin);
      setCopiedId(id);
      toast.success("ASIN copied!");
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      toast.error("Failed to copy");
    }
  };

  const handleToggleIgnore = async (e: React.MouseEvent, alert: LowRoiAlert) => {
    e.stopPropagation();
    if (!user) return;

    const newIgnored = !alert.ignored;
    
    // Optimistic update
    setAlerts(prev => prev.map(a => 
      a.id === alert.id ? { ...a, ignored: newIgnored } : a
    ));

    const { error } = await supabase
      .from("roi_alerts")
      .update({ ignored: newIgnored })
      .eq("id", alert.id)
      .eq("user_id", user.id);

    if (error) {
      // Revert on error
      setAlerts(prev => prev.map(a => 
        a.id === alert.id ? { ...a, ignored: !newIgnored } : a
      ));
      toast.error("Failed to update");
    } else {
      toast.success(newIgnored ? "Alert hidden" : "Alert restored");
    }
  };

  // Load user's ROI threshold setting
  useEffect(() => {
    if (!user) return;
    const loadThreshold = async () => {
      const { data } = await supabase
        .from("user_settings")
        .select("roi_alert_threshold")
        .eq("user_id", user.id)
        .maybeSingle();
      if (data) {
        setRoiThreshold(Number(data.roi_alert_threshold));
      }
    };
    loadThreshold();
  }, [user]);

  const consecutiveFailsRef = useRef(0);

  // Fetch low ROI alerts from roi_alerts table (single source of truth)
  useEffect(() => {
    if (!user) {
      setAlerts([]);
      return;
    }

    const fetchAlerts = async () => {
      if (isQueryCircuitOpen('roi_alerts')) return;

      // Get today in local timezone
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: tz });

      // Query roi_alerts table directly - no calculation needed!
      const { data, error } = await supabase
        .from("roi_alerts")
        .select("id, asin, title, order_date, units, roi, status, seen, ignored")
        .eq("user_id", user.id)
        .eq("order_date", todayStr)
        .lt("roi", roiThreshold)
        .order("roi", { ascending: true })
        .limit(20);

      if (error) {
        if (isTimeoutError(error)) {
          recordDbFailure('roi_alerts');
          consecutiveFailsRef.current++;
        }
        console.error("Error fetching ROI alerts:", error);
        return;
      }
      consecutiveFailsRef.current = 0;
      recordDbSuccess('roi_alerts');

      const alertRows = (data || []) as RoiAlertRow[];
      
      // Build seen set from DB
      const dbSeenIds = new Set(alertRows.filter(r => r.seen).map(r => r.id));
      setSeenIds(prev => new Set([...prev, ...dbSeenIds]));

      setAlerts(alertRows.map(row => ({
        id: row.id,
        asin: row.asin,
        title: row.title,
        roi: Number(row.roi),
        order_date: row.order_date,
        units: row.units,
        ignored: row.ignored,
      })));
    };

    fetchAlerts();

    // Dynamic interval with backoff under DB pressure
    const BASE_INTERVAL = 60000;
    let timer: NodeJS.Timeout;
    const scheduleNext = () => {
      if (isQueryCircuitOpen('roi_alerts')) {
        timer = setTimeout(scheduleNext, BASE_INTERVAL * 8);
        return;
      }
      const multiplier = getBackoffMultiplier();
      const failMultiplier = consecutiveFailsRef.current >= 3 ? 4 : 1;
      const interval = BASE_INTERVAL * multiplier * failMultiplier;
      timer = setTimeout(() => {
        fetchAlerts().then(scheduleNext);
      }, interval);
    };
    scheduleNext();
    return () => clearTimeout(timer);
  }, [user, roiThreshold]);

  // Mark all as seen when popover opens
  const handleOpenChange = async (open: boolean) => {
    setIsOpen(open);
    if (open && alerts.length > 0 && user) {
      const unseenAlertIds = alerts.filter(a => !seenIds.has(a.id) && !a.ignored).map(a => a.id);
      
      if (unseenAlertIds.length > 0) {
        // Update DB to mark as seen
        await supabase
          .from("roi_alerts")
          .update({ seen: true })
          .eq("user_id", user.id)
          .in("id", unseenAlertIds);

        const newSeenIds = new Set([...seenIds, ...unseenAlertIds]);
        setSeenIds(newSeenIds);
      }
    }
  };

  // Count unseen alerts (excluding ignored)
  const unseenCount = alerts.filter((a) => !seenIds.has(a.id) && !a.ignored).length;
  
  // Filter alerts based on showHidden toggle
  const visibleAlerts = showHidden ? alerts : alerts.filter(a => !a.ignored);
  const hiddenCount = alerts.filter(a => a.ignored).length;

  // Navigate to Sales page filtered to that date
  const handleAlertClick = (alert: LowRoiAlert) => {
    setIsOpen(false);
    navigate(`/tools/sales?date=${alert.order_date}`);
  };

  if (!user) return null;

  return (
    <Popover open={isOpen} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="relative">
          <Bell className="h-4 w-4" />
          {unseenCount > 0 && (
            <Badge
              variant="destructive"
              className="absolute -top-1 -right-1 h-5 w-5 p-0 flex items-center justify-center text-xs"
            >
              {unseenCount > 9 ? "9+" : unseenCount}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="end">
        <div className="p-3 border-b">
          <div className="flex items-center justify-between">
            <div>
              <h4 className="font-semibold text-sm">Low ROI Alerts (&lt;{roiThreshold}%)</h4>
              <p className="text-xs text-muted-foreground">Today's pending orders with low ROI</p>
            </div>
            {hiddenCount > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => setShowHidden(!showHidden)}
              >
                {showHidden ? <Eye className="h-3.5 w-3.5 mr-1" /> : <EyeOff className="h-3.5 w-3.5 mr-1" />}
                {hiddenCount}
              </Button>
            )}
          </div>
        </div>
        {visibleAlerts.length === 0 ? (
          <div className="p-4 text-center text-sm text-muted-foreground">
            {hiddenCount > 0 ? "All alerts hidden" : "No low ROI alerts 🎉"}
          </div>
        ) : (
          <ScrollArea className="h-[300px]">
            <div className="divide-y">
              {visibleAlerts.map((alert) => (
                <div
                  key={alert.id}
                  className={`w-full p-3 hover:bg-muted/50 transition-colors ${alert.ignored ? 'opacity-50' : ''}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <button
                      onClick={() => handleAlertClick(alert)}
                      className="font-mono text-sm font-medium text-primary hover:underline text-left"
                    >
                      {alert.asin}
                    </button>
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={(e) => handleToggleIgnore(e, alert)}
                        className="h-7 w-7 flex items-center justify-center rounded-md border border-border bg-background hover:bg-muted transition-colors"
                        title={alert.ignored ? "Unhide ASIN" : "Hide ASIN"}
                      >
                        {alert.ignored ? (
                          <Eye className="h-3.5 w-3.5 text-muted-foreground" />
                        ) : (
                          <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />
                        )}
                      </button>
                      <button
                        onClick={(e) => handleCopyAsin(e, alert.asin, alert.id)}
                        className="h-7 w-7 flex items-center justify-center rounded-md border border-border bg-background hover:bg-muted transition-colors"
                        title="Copy ASIN"
                      >
                        {copiedId === alert.id ? (
                          <Check className="h-3.5 w-3.5 text-green-500" />
                        ) : (
                          <Copy className="h-3.5 w-3.5 text-muted-foreground" />
                        )}
                      </button>
                      <span
                        className={`text-sm font-bold min-w-[50px] text-right ${
                          alert.roi < 0
                            ? "text-red-600"
                            : alert.roi < 10
                            ? "text-orange-500"
                            : "text-yellow-600"
                        }`}
                      >
                        {alert.roi.toFixed(1)}%
                      </span>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1 truncate">
                    {alert.units} unit{alert.units !== 1 ? 's' : ''} • {new Date(alert.order_date + "T12:00:00").toLocaleDateString()}
                  </p>
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
        <div className="p-2 border-t flex gap-2">
          <Button
            variant="outline"
            size="sm"
            className="flex-1 text-xs"
            onClick={async () => {
              const asins = visibleAlerts.map(a => a.asin).join(", ");
              if (!asins) {
                toast.info("No ASINs to copy");
                return;
              }
              try {
                await navigator.clipboard.writeText(asins);
                toast.success(`${visibleAlerts.length} ASINs copied!`);
              } catch {
                toast.error("Failed to copy");
              }
            }}
          >
            <Copy className="h-3 w-3 mr-1" />
            Copy All
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="flex-1 text-xs"
            onClick={() => {
              setIsOpen(false);
              navigate("/tools/sales");
            }}
          >
            View Sales →
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
