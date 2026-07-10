import { useState, useEffect, useCallback, useRef } from "react";
import { AlertTriangle, Star, X, Volume2, VolumeX, Copy } from "lucide-react";
import { useNavigate } from "react-router-dom";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { isQueryCircuitOpen, isTimeoutError, recordDbFailure, recordDbSuccess, getBackoffMultiplier } from "@/hooks/use-db-pressure";

interface BbAlert {
  id: string;
  asin: string;
  sku: string | null;
  marketplace: string;
  bb_before: number | null;
  bb_now: number | null;
  drop_abs: number | null;
  drop_pct: number | null;
  my_price: number | null;
  seen: boolean;
  dismissed: boolean;
  acted: boolean;
  created_at: string;
}

const ALERT_SOUND_KEY = "bb_alert_sound_enabled";

export default function BbPriceAlerts() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [alerts, setAlerts] = useState<BbAlert[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [soundEnabled, setSoundEnabled] = useState(() => {
    try { return localStorage.getItem(ALERT_SOUND_KEY) !== "false"; } catch { return true; }
  });
  const [prevUnseenCount, setPrevUnseenCount] = useState(0);

  const consecutiveFailsRef = useRef(0);

  const fetchAlerts = useCallback(async () => {
    if (!user) return;
    if (isQueryCircuitOpen('bb_price_alerts')) return;

    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from("bb_price_alerts")
      .select("*")
      .eq("user_id", user.id)
      .eq("dismissed", false)
      .gte("created_at", cutoff)
      .order("created_at", { ascending: false })
      .limit(30);

    if (error) {
      if (isTimeoutError(error)) {
        recordDbFailure('bb_price_alerts');
        consecutiveFailsRef.current++;
      }
      console.error("Error fetching BB alerts:", error);
      return;
    }
    consecutiveFailsRef.current = 0;
    recordDbSuccess('bb_price_alerts');
    const newAlerts = (data || []) as BbAlert[];
    const newUnseen = newAlerts.filter(a => !a.seen).length;

    // Play sound if new unseen alerts appeared
    if (soundEnabled && newUnseen > prevUnseenCount && prevUnseenCount >= 0) {
      try {
        const audio = new Audio("data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbsGczHjyIw+DRfjEUOX6+2NV+LBE2dLjU1IAoDS1rsdDUhigMLWmv0NSIKA0ta7HQ1IYoDS1rsdDUhigMLWmv0NSIKA0ta7HQ1IYo");
        audio.volume = 0.3;
        audio.play().catch(() => {});
      } catch {}
    }
    setPrevUnseenCount(newUnseen);
    setAlerts(newAlerts);
  }, [user, soundEnabled, prevUnseenCount]);

  useEffect(() => {
    if (!user) { setAlerts([]); return; }
    fetchAlerts();
    // Dynamic interval: backs off under DB pressure
    const BASE_INTERVAL = 30000;
    let timer: NodeJS.Timeout;
    const scheduleNext = () => {
      if (isQueryCircuitOpen('bb_price_alerts')) {
        timer = setTimeout(scheduleNext, BASE_INTERVAL * 12);
        return;
      }
      const multiplier = getBackoffMultiplier();
      // Also back off if this specific query keeps failing
      const failMultiplier = consecutiveFailsRef.current >= 3 ? 4 : 1;
      const interval = BASE_INTERVAL * multiplier * failMultiplier;
      timer = setTimeout(() => {
        fetchAlerts().then(scheduleNext);
      }, interval);
    };
    scheduleNext();
    return () => clearTimeout(timer);
  }, [user, fetchAlerts]);

  const handleOpenChange = async (open: boolean) => {
    setIsOpen(open);
    if (open && user) {
      const unseenIds = alerts.filter(a => !a.seen).map(a => a.id);
      if (unseenIds.length > 0) {
        await supabase
          .from("bb_price_alerts")
          .update({ seen: true })
          .eq("user_id", user.id)
          .in("id", unseenIds);
        setAlerts(prev => prev.map(a => unseenIds.includes(a.id) ? { ...a, seen: true } : a));
      }
    }
  };

  const handleDismiss = async (e: React.MouseEvent, alertId: string) => {
    e.stopPropagation();
    if (!user) return;
    setAlerts(prev => prev.filter(a => a.id !== alertId));
    await supabase
      .from("bb_price_alerts")
      .update({ dismissed: true })
      .eq("id", alertId)
      .eq("user_id", user.id);
  };

  const handleStar = async (e: React.MouseEvent, alert: BbAlert) => {
    e.stopPropagation();
    if (!user) return;
    // Toggle is_priority on the repricer_assignment for this ASIN
    const { data: assignment } = await supabase
      .from("repricer_assignments")
      .select("id, is_priority")
      .eq("user_id", user.id)
      .eq("asin", alert.asin)
      .eq("marketplace", alert.marketplace)
      .eq("is_enabled", true)
      .maybeSingle();

    if (!assignment) {
      toast.error("No active assignment found for " + alert.asin);
      return;
    }

    const newPriority = !assignment.is_priority;
    const { error } = await supabase
      .from("repricer_assignments")
      .update({ is_priority: newPriority })
      .eq("id", assignment.id);

    if (error) {
      toast.error("Failed to update priority");
      return;
    }

    // Mark alert as acted
    await supabase
      .from("bb_price_alerts")
      .update({ acted: true })
      .eq("id", alert.id)
      .eq("user_id", user.id);

    setAlerts(prev => prev.map(a => a.id === alert.id ? { ...a, acted: true } : a));
    toast.success(newPriority ? `⭐ ${alert.asin} added to Turbo` : `${alert.asin} removed from Turbo`);
  };

  const toggleSound = () => {
    const next = !soundEnabled;
    setSoundEnabled(next);
    try { localStorage.setItem(ALERT_SOUND_KEY, String(next)); } catch {}
  };

  const fmt = (v: number | null) => v != null ? `$${v.toFixed(2)}` : "—";
  const unseenCount = alerts.filter(a => !a.seen).length;
  const filteredAlerts = searchTerm
    ? alerts.filter(a => a.asin.toLowerCase().includes(searchTerm.toLowerCase()) || (a.sku && a.sku.toLowerCase().includes(searchTerm.toLowerCase())))
    : alerts;

  if (!user) return null;

  return (
    <Popover open={isOpen} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="relative">
          <AlertTriangle className="h-4 w-4 text-orange-500" />
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
      <PopoverContent className="w-96 p-0" align="end">
        <div className="p-3 border-b">
          <div className="flex items-center justify-between">
            <div>
              <h4 className="font-semibold text-sm flex items-center gap-1.5">
                <AlertTriangle className="h-4 w-4 text-orange-500" />
                Buy Box Price Alerts
              </h4>
              <p className="text-xs text-muted-foreground">BB drops detected by scheduler</p>
            </div>
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={toggleSound} title={soundEnabled ? "Mute alerts" : "Unmute alerts"}>
              {soundEnabled ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5 text-muted-foreground" />}
            </Button>
          </div>
        </div>
        {alerts.length > 0 && (
          <div className="px-3 py-2 border-b">
            <input
              type="text"
              placeholder="Search ASIN or SKU..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full text-sm px-2 py-1.5 rounded border border-input bg-background placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
        )}
        {filteredAlerts.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">
            {alerts.length === 0 ? "No price drop alerts 🎉" : "No matching alerts"}
          </div>
        ) : (
          <ScrollArea className="h-[340px]">
            <div className="divide-y">
              {filteredAlerts.map((alert) => {
                const gapToBb = alert.my_price != null && alert.bb_now != null
                  ? alert.my_price - alert.bb_now : null;
                const severity = (alert.drop_pct ?? 0) >= 2 ? "red" : (alert.drop_pct ?? 0) >= 1 ? "orange" : "yellow";
                const severityColor = severity === "red" ? "text-red-600 bg-red-50" : severity === "orange" ? "text-orange-600 bg-orange-50" : "text-yellow-600 bg-yellow-50";
                const timeAgo = getTimeAgo(alert.created_at);

                return (
                  <div
                    key={alert.id}
                    className={`p-3 hover:bg-muted/50 transition-colors ${!alert.seen ? 'bg-orange-50/30' : ''}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => { setIsOpen(false); navigate("/tools/repricer"); }}
                            className="font-mono text-sm font-medium text-primary hover:underline"
                          >
                            {alert.asin}
                          </button>
                          <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${severityColor}`}>
                            ↓{fmt(alert.drop_abs)} ({alert.drop_pct?.toFixed(1)}%)
                          </span>
                        </div>
                        <div className="text-xs text-muted-foreground mt-1 grid grid-cols-2 gap-x-3">
                          <span>BB Before: {fmt(alert.bb_before)}</span>
                          <span>BB Now: <span className="font-medium text-foreground">{fmt(alert.bb_now)}</span></span>
                          <span>My Price: {fmt(alert.my_price)}</span>
                          <span>Gap: {gapToBb != null ? (gapToBb > 0 ? `+${fmt(gapToBb)}` : fmt(gapToBb)) : "—"}</span>
                        </div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {alert.sku && <span className="mr-2">SKU: {alert.sku}</span>}
                          <span>{timeAgo}</span>
                        </div>
                      </div>
                      <div className="flex flex-col gap-1">
                        <Button
                          variant={alert.acted ? "default" : "outline"}
                          size="sm"
                          className="h-7 w-7 p-0"
                          onClick={(e) => handleStar(e, alert)}
                          title="Toggle Turbo/Priority"
                        >
                          <Star className={`h-3.5 w-3.5 ${alert.acted ? 'fill-current' : ''}`} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0"
                          onClick={(e) => handleDismiss(e, alert.id)}
                          title="Dismiss"
                        >
                          <X className="h-3.5 w-3.5 text-muted-foreground" />
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        )}
        {alerts.length > 0 && (
          <div className="p-2 border-t flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="flex-1 text-xs"
              onClick={() => {
                const uniqueAsins = [...new Set(alerts.map(a => a.asin))];
                navigator.clipboard.writeText(uniqueAsins.join(", "));
                toast.success(`Copied ${uniqueAsins.length} ASINs`);
              }}
            >
              <Copy className="h-3 w-3 mr-1" />
              Copy All ASINs
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="flex-1 text-xs"
              onClick={async () => {
                if (!user) return;
                const ids = alerts.map(a => a.id);
                await supabase
                  .from("bb_price_alerts")
                  .update({ dismissed: true })
                  .eq("user_id", user.id)
                  .in("id", ids);
                setAlerts([]);
                toast.success("All alerts dismissed");
              }}
            >
              Dismiss All
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function getTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
