import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Activity } from "lucide-react";

interface Props {
  categoryId: string;
  refreshKey?: number;
}

interface JobRow {
  status: string;
  added_count: number;
  removed_count: number;
  changed_count: number;
  unchanged_count: number;
  fetch_failed_count: number;
  parse_failed_count: number;
  pdp_queued_count: number;
  duration_ms: number | null;
  estimated_cost: number;
  completed_at: string | null;
  started_at: string;
  error: string | null;
}

export const ScanStatsBadge = ({ categoryId, refreshKey }: Props) => {
  const [job, setJob] = useState<JobRow | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data } = await supabase
        .from("category_scan_jobs")
        .select("status, added_count, removed_count, changed_count, unchanged_count, fetch_failed_count, parse_failed_count, pdp_queued_count, duration_ms, estimated_cost, completed_at, started_at, error")
        .eq("category_id", categoryId)
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!cancelled) {
        setJob(data as JobRow | null);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [categoryId, refreshKey]);

  if (loading) return null;
  if (!job) {
    return (
      <Badge variant="outline" className="gap-1">
        <Activity className="h-3 w-3" /> No scans yet
      </Badge>
    );
  }

  const variant: "default" | "secondary" | "destructive" =
    job.status === "completed" ? "secondary"
    : job.status === "failed" ? "destructive"
    : "default";

  const summary =
    job.status === "running" ? "Running..."
    : job.status === "failed" ? "Last scan failed"
    : `+${job.added_count} ~${job.changed_count} -${job.removed_count}`;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant={variant} className="gap-1 cursor-help">
            <Activity className="h-3 w-3" /> {summary}
          </Badge>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          <div className="space-y-1 text-xs">
            <div className="font-semibold capitalize">{job.status}</div>
            <div>Added: <b>{job.added_count}</b> · Changed: <b>{job.changed_count}</b> · Removed: <b>{job.removed_count}</b> · Unchanged: <b>{job.unchanged_count}</b></div>
            <div>PDP queued: <b>{job.pdp_queued_count}</b> · Fetch fails: <b>{job.fetch_failed_count}</b> · Parse fails: <b>{job.parse_failed_count}</b></div>
            {job.duration_ms != null && <div>Duration: <b>{(job.duration_ms / 1000).toFixed(1)}s</b></div>}
            <div>Est. cost: <b>${job.estimated_cost.toFixed(4)}</b></div>
            {job.error && <div className="text-destructive">Error: {job.error}</div>}
            <div className="text-muted-foreground">{new Date(job.completed_at ?? job.started_at).toLocaleString()}</div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};
