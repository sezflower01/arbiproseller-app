import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { RefreshCw, Rss, Copy } from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";

interface FeedRow {
  id: string;
  feed_id: string | null;
  status: string;
  sku_count: number;
  skus_succeeded: number | null;
  skus_failed: number | null;
  submitted_at: string;
  completed_at: string | null;
  error_message: string | null;
}

export default function FeedSubmissionsTable() {
  const [feeds, setFeeds] = useState<FeedRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [timeFilter, setTimeFilter] = useState("today");

  const fetchFeeds = async () => {
    setLoading(true);
    let query = supabase
      .from("repricer_feed_submissions")
      .select("id, feed_id, status, sku_count, skus_succeeded, skus_failed, submitted_at, completed_at, error_message")
      .order("submitted_at", { ascending: false })
      .limit(100);

    if (timeFilter === "today") {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      query = query.gte("submitted_at", todayStart.toISOString());
    } else if (timeFilter === "7days") {
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      query = query.gte("submitted_at", weekAgo.toISOString());
    }

    const { data, error } = await query;
    if (!error) setFeeds((data || []) as FeedRow[]);
    setLoading(false);
  };

  useEffect(() => { fetchFeeds(); }, [timeFilter]);

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "completed": return <Badge className="bg-green-500">Completed</Badge>;
      case "DONE": return <Badge className="bg-green-500">Done</Badge>;
      case "DONE_NO_REPORT": return <Badge className="bg-yellow-500">Done (No Report)</Badge>;
      case "IN_QUEUE": return <Badge className="bg-blue-400">In Queue</Badge>;
      case "IN_PROGRESS": return <Badge className="bg-blue-500">Processing</Badge>;
      case "failed":
      case "FATAL": return <Badge variant="destructive">Failed</Badge>;
      default: return <Badge variant="secondary">{status}</Badge>;
    }
  };

  const getDuration = (feed: FeedRow) => {
    if (!feed.completed_at) return "—";
    const ms = new Date(feed.completed_at).getTime() - new Date(feed.submitted_at).getTime();
    return ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60000)}m`;
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-lg flex items-center gap-2">
          <Rss className="h-5 w-5" />
          Feed Submissions
        </CardTitle>
        <div className="flex items-center gap-2">
          <Select value={timeFilter} onValueChange={setTimeFilter}>
            <SelectTrigger className="w-[120px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="today">Today</SelectItem>
              <SelectItem value="7days">7 Days</SelectItem>
              <SelectItem value="30days">30 Days</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={fetchFeeds}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="text-center py-6 text-muted-foreground">Loading...</div>
        ) : feeds.length === 0 ? (
          <div className="text-center py-6 text-muted-foreground">No feeds in this period</div>
        ) : (
          <div className="border rounded-lg overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Feed ID</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Success</TableHead>
                  <TableHead className="text-right">Failed</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {feeds.map((feed) => (
                  <TableRow key={feed.id}>
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                      {format(new Date(feed.submitted_at), "MMM d, HH:mm")}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <span className="font-mono text-xs truncate max-w-[120px]">
                          {feed.feed_id || "—"}
                        </span>
                        {feed.feed_id && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-5 w-5 p-0"
                            onClick={() => {
                              navigator.clipboard.writeText(feed.feed_id!);
                              toast.success("Copied");
                            }}
                          >
                            <Copy className="h-3 w-3" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>{getStatusBadge(feed.status)}</TableCell>
                    <TableCell className="text-right font-mono">{feed.sku_count}</TableCell>
                    <TableCell className="text-right font-mono text-green-600">
                      {feed.skus_succeeded ?? "—"}
                    </TableCell>
                    <TableCell className="text-right font-mono text-red-600">
                      {feed.skus_failed ?? "—"}
                    </TableCell>
                    <TableCell className="text-xs">{getDuration(feed)}</TableCell>
                    <TableCell className="text-xs text-red-500 max-w-[200px] truncate">
                      {feed.error_message || "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
