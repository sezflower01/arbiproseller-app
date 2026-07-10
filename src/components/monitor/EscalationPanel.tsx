import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { AlertOctagon, Plus, Clock } from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";
import type { MonitorData } from "@/hooks/use-monitor-data";
import { useSalesVelocity } from "@/hooks/use-sales-velocity";

interface Incident {
  id: string;
  severity: string;
  category: string;
  notes: string | null;
  status: string;
  created_at: string;
}

interface Props {
  data: MonitorData;
}

export default function EscalationPanel({ data }: Props) {
  const { user } = useAuth();
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [severity, setSeverity] = useState("medium");
  const [category, setCategory] = useState("feed_stuck");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Sales velocity for top mismatch ASINs
  const { velocityMap } = useSalesVelocity(data.topMismatchAsins);

  const fetchIncidents = async () => {
    const { data: rows } = await supabase
      .from("repricer_incidents")
      .select("*")
      .eq("status", "open")
      .order("created_at", { ascending: false })
      .limit(20);
    setIncidents((rows || []) as Incident[]);
  };

  useEffect(() => { fetchIncidents(); }, []);

  const submitIncident = async () => {
    if (!user || !notes.trim()) {
      toast.error("Please add notes describing the issue");
      return;
    }
    setSubmitting(true);
    try {
      const snapshot = {
        schedulerRuns: data.schedulerRuns,
        feedCompletionRate: data.feedCompletionRate,
        verificationRate: data.verificationRate,
        mismatchCount: data.mismatchCount,
        profitGuardBlocks: data.profitGuardBlocks,
        timestamp: new Date().toISOString(),
      };

      const { error } = await supabase.from("repricer_incidents").insert({
        user_id: user.id,
        severity,
        category,
        notes,
        summary_snapshot: snapshot,
      });

      if (error) throw error;
      toast.success("Incident escalated");
      setDialogOpen(false);
      setNotes("");
      fetchIncidents();
    } catch (err: any) {
      toast.error("Failed: " + err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const getSeverityColor = (s: string) => {
    switch (s) {
      case "high": return "destructive";
      case "medium": return "default";
      case "low": return "secondary";
      default: return "secondary";
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-lg flex items-center gap-2">
          <AlertOctagon className="h-5 w-5 text-red-500" />
          Escalation Panel
        </CardTitle>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button size="sm" variant="destructive">
              <Plus className="h-4 w-4 mr-1" />
              Escalate Issue
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Escalate Repricer Issue</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium">Severity</label>
                <Select value={severity} onValueChange={setSeverity}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-sm font-medium">Category</label>
                <Select value={category} onValueChange={setCategory}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="feed_stuck">Feed Stuck</SelectItem>
                    <SelectItem value="verification_mismatch">Verification Mismatches</SelectItem>
                    <SelectItem value="amazon_rejected">Amazon Rejected</SelectItem>
                    <SelectItem value="profit_guard_spike">Profit Guard Spike</SelectItem>
                    <SelectItem value="scheduler_down">Scheduler Down</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-sm font-medium">Notes</label>
                <Textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Describe what you observed..."
                  rows={4}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Current stats will be auto-attached: {data.feedCompletionRate}% feed completion, {data.verificationRate}% verification, {data.mismatchCount} mismatches
              </p>
              {data.topMismatchAsins.length > 0 && (
                <div className="text-xs text-muted-foreground border rounded p-2 space-y-1">
                  <span className="font-medium">Sales velocity (top mismatches):</span>
                  {data.topMismatchAsins.slice(0, 3).map((asin) => {
                    const v = velocityMap[asin];
                    return (
                      <div key={asin} className="font-mono">
                        {asin}: {v ? `${v.units_30d} units / ${v.orders_30d} orders (last sale: ${v.days_since_last_sale != null ? `${v.days_since_last_sale}d ago` : "never"})` : "loading..."}
                      </div>
                    );
                  })}
                </div>
              )}
              <Button onClick={submitIncident} disabled={submitting} className="w-full">
                {submitting ? "Submitting..." : "Submit Escalation"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent>
        {incidents.length === 0 ? (
          <div className="text-center py-6 text-muted-foreground">
            No open incidents — system is healthy
          </div>
        ) : (
          <div className="space-y-3">
            {incidents.map((inc) => (
              <div key={inc.id} className="flex items-start gap-3 p-3 border rounded-lg">
                <Clock className="h-4 w-4 mt-1 text-muted-foreground" />
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <Badge variant={getSeverityColor(inc.severity) as any}>
                      {inc.severity.toUpperCase()}
                    </Badge>
                    <Badge variant="outline">{inc.category.replace(/_/g, " ")}</Badge>
                    <span className="text-xs text-muted-foreground">
                      {format(new Date(inc.created_at), "MMM d, HH:mm")}
                    </span>
                  </div>
                  <p className="text-sm">{inc.notes}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
