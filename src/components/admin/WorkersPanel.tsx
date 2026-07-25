import { useState, useEffect, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Loader2, Search, Server, AlertTriangle } from "lucide-react";

interface WorkerUser {
  user_id: string;
  email: string;
  name: string | null;
  shard: string;
  scheduler_enabled: boolean;
  queue_paused: boolean;
}

interface ShardCount {
  total: number;
  active: number;
}

export default function WorkersPanel() {
  const [users, setUsers] = useState<WorkerUser[]>([]);
  const [shardCounts, setShardCounts] = useState<Record<string, ShardCount>>({});
  const [provisionedShards, setProvisionedShards] = useState<string[]>(["A", "B"]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [savingUserId, setSavingUserId] = useState<string | null>(null);

  useEffect(() => { loadWorkers(); }, []);

  const loadWorkers = async () => {
    setLoading(true);
    const { data, error } = await supabase.functions.invoke("admin-workers", {
      body: { action: "list" },
    });
    if (!error && data?.users) {
      setUsers(data.users);
      setShardCounts(data.shardCounts || {});
      setProvisionedShards(data.provisionedShards || ["A", "B"]);
    } else {
      toast.error("Failed to load workers");
    }
    setLoading(false);
  };

  const setShard = async (userId: string, shard: string) => {
    setSavingUserId(userId);
    const { data, error } = await supabase.functions.invoke("admin-workers", {
      body: { action: "set_shard", user_id: userId, shard },
    });
    if (error || data?.error) {
      toast.error(data?.error || "Failed to update shard");
    } else {
      setUsers((prev) => prev.map((u) => (u.user_id === userId ? { ...u, shard } : u)));
      if (data?.unprovisioned) {
        toast.warning(`Saved, but shard ${shard} has no scheduled worker yet — this account won't be checked until it's provisioned.`, { duration: 8000 });
      } else {
        toast.success(`Moved to Worker ${shard}`);
      }
    }
    setSavingUserId(null);
  };

  const filteredUsers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (u) => u.email.toLowerCase().includes(q) || (u.name || "").toLowerCase().includes(q)
    );
  }, [users, search]);

  const shardLetters = useMemo(() => {
    const letters = new Set([...provisionedShards, ...Object.keys(shardCounts)]);
    return Array.from(letters).sort();
  }, [provisionedShards, shardCounts]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Server className="h-5 w-5" />
            Shard Load
          </CardTitle>
          <CardDescription>
            Each shard is an independent scheduled worker that only processes accounts assigned to it — splitting the
            total account base so no single worker gets overloaded as more users sign up.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
            {shardLetters.map((letter) => {
              const counts = shardCounts[letter] || { total: 0, active: 0 };
              const isProvisioned = provisionedShards.includes(letter);
              return (
                <div key={letter} className="rounded-lg border p-4 bg-muted/30">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-semibold">Worker {letter}</span>
                    {!isProvisioned && (
                      <Badge variant="destructive" className="text-[10px] gap-1">
                        <AlertTriangle className="h-3 w-3" />
                        No cron job
                      </Badge>
                    )}
                  </div>
                  <p className="text-2xl font-bold">{counts.active}</p>
                  <p className="text-xs text-muted-foreground">active / {counts.total} total assigned</p>
                </div>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground mt-4">
            "No cron job" means accounts on that shard have no scheduled worker actually checking their prices — don't
            assign accounts there until a matching pg_cron job is provisioned for it.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Reassign Accounts</CardTitle>
          <CardDescription>Search for an account and move it to a different shard.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="relative max-w-sm">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by email or name…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Showing {filteredUsers.length} of {users.length} accounts loaded
          </p>
          <div className="space-y-1.5 max-h-[500px] overflow-y-auto">
            {filteredUsers.length === 0 ? (
              <p className="text-sm text-muted-foreground py-6 text-center">No accounts match your search.</p>
            ) : (
              filteredUsers.map((u) => (
                <div
                  key={u.user_id}
                  className="flex items-center justify-between gap-3 p-2.5 rounded border bg-background text-sm"
                >
                  <div className="min-w-0">
                    <p className="font-medium truncate">{u.name || u.email}</p>
                    <p className="text-xs text-muted-foreground truncate">{u.email}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {!u.scheduler_enabled && (
                      <Badge variant="outline" className="text-[10px]">Disabled</Badge>
                    )}
                    {u.queue_paused && (
                      <Badge variant="outline" className="text-[10px]">Paused</Badge>
                    )}
                    <Select
                      value={u.shard}
                      onValueChange={(val) => setShard(u.user_id, val)}
                      disabled={savingUserId === u.user_id}
                    >
                      <SelectTrigger className="w-24 h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {shardLetters.map((letter) => (
                          <SelectItem key={letter} value={letter}>
                            Worker {letter}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
