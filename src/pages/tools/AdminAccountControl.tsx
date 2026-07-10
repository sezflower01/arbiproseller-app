import { useState, useEffect } from "react";
import { Helmet } from "react-helmet-async";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useSubscription } from "@/hooks/use-subscription";
import { toast } from "sonner";
import { useNavigate } from "react-router-dom";
import {
  Shield, Loader2, Search, Pause, Ban, RotateCcw, Trash2,
  CheckCircle2, AlertTriangle, XCircle, MinusCircle
} from "lucide-react";

interface UserAccount {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  account_status: string;
  account_status_reason: string | null;
  account_status_changed_at: string | null;
  created_at: string;
  subscription: {
    plan_id: string;
    status: string;
    cancel_at_period_end: boolean;
    current_period_end: string | null;
  } | null;
  repricer: {
    scheduler_enabled: boolean;
  } | null;
  amazon_auths: Array<{
    is_active: boolean;
    marketplace_id: string;
  }>;
}

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  active: { label: "Active", color: "bg-green-500/10 text-green-700 border-green-200", icon: <CheckCircle2 className="h-3.5 w-3.5" /> },
  paused: { label: "Paused", color: "bg-yellow-500/10 text-yellow-700 border-yellow-200", icon: <Pause className="h-3.5 w-3.5" /> },
  suspended: { label: "Suspended", color: "bg-red-500/10 text-red-700 border-red-200", icon: <Ban className="h-3.5 w-3.5" /> },
  deleted: { label: "Deleted", color: "bg-muted text-muted-foreground border-border", icon: <XCircle className="h-3.5 w-3.5" /> },
};

export default function AdminAccountControl() {
  const { user } = useAuth();
  const { isAdmin, loading: subLoading } = useSubscription();
  const navigate = useNavigate();
  const [users, setUsers] = useState<UserAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [actionDialog, setActionDialog] = useState<{
    action: string;
    user: UserAccount;
  } | null>(null);
  const [reason, setReason] = useState("");
  const [acting, setActing] = useState(false);

  useEffect(() => {
    if (subLoading) return;
    if (!isAdmin) { navigate("/tools"); return; }
    loadUsers();
  }, [isAdmin, subLoading]);

  const loadUsers = async () => {
    setLoading(true);
    const { data, error } = await supabase.functions.invoke("admin-manage-account", {
      body: { action: "list_users" },
    });
    if (!error && data?.users) setUsers(data.users);
    else toast.error("Failed to load users");
    setLoading(false);
  };

  const executeAction = async () => {
    if (!actionDialog) return;
    setActing(true);
    const currentAction = actionDialog.action;
    const currentUserId = actionDialog.user.id;

    const { data, error } = await supabase.functions.invoke("admin-manage-account", {
      body: {
        action: currentAction,
        user_id: currentUserId,
        reason: reason || undefined,
      },
    });

    if (error || data?.error) {
      toast.error(data?.error || "Action failed");
    } else {
      toast.success(data?.message || "Action completed");
      if (currentAction === "delete") {
        setUsers((prev) => prev.filter((u) => u.id !== currentUserId));
      }
      await loadUsers();
    }

    setActing(false);
    setActionDialog(null);
    setReason("");
  };

  const filtered = users.filter((u) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      u.email?.toLowerCase().includes(q) ||
      u.first_name?.toLowerCase().includes(q) ||
      u.last_name?.toLowerCase().includes(q) ||
      u.account_status?.toLowerCase().includes(q)
    );
  });

  if (!isAdmin) return null;

  const getActionLabel = (action: string) => {
    switch (action) {
      case "pause": return "Pause Account";
      case "suspend": return "Suspend Account";
      case "restore": return "Restore Account";
      case "delete": return "Delete Account Permanently";
      default: return action;
    }
  };

  const getActionDescription = (action: string) => {
    switch (action) {
      case "pause": return "This will disable the repricer and disconnect Amazon, but the user can still log in and reactivate later. All data is preserved.";
      case "suspend": return "This will block the user from logging in, disable repricing, and disconnect Amazon. Data is preserved. You can restore access later.";
      case "restore": return "This will unblock login, restore Amazon connection, and set the account back to active. The user can re-enable their repricer.";
      case "delete": return "This will permanently block login, terminate subscriptions, and disable all services. The user must sign up again to return. This action is hard to reverse.";
      default: return "";
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <Helmet><title>Account Control — Admin</title></Helmet>
      <Navbar />
      <main className="flex-grow pt-24 pb-16">
        <div className="container mx-auto px-4 max-w-5xl space-y-6">
          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center">
                  <Shield className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <CardTitle className="text-xl">Account Control Panel</CardTitle>
                  <CardDescription>Manage user account states: pause, suspend, restore, or delete</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by email, name, or status…"
                  className="pl-10"
                />
              </div>

              {loading ? (
                <div className="flex justify-center py-12">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : filtered.length === 0 ? (
                <p className="text-center text-muted-foreground py-8">No users found</p>
              ) : (
                <div className="space-y-3">
                  {filtered.map((u) => {
                    const statusCfg = STATUS_CONFIG[u.account_status] || STATUS_CONFIG.active;
                    const activeAuths = u.amazon_auths.filter((a) => a.is_active).length;
                    const isSelf = u.id === user?.id;

                    return (
                      <div
                        key={u.id}
                        className="rounded-xl border border-border bg-card p-4 hover:bg-accent/20 transition-colors"
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-medium text-sm truncate">
                                {u.email}
                              </span>
                              {isSelf && (
                                <Badge variant="outline" className="text-xs">You</Badge>
                              )}
                              <Badge variant="outline" className={`text-xs flex items-center gap-1 ${statusCfg.color}`}>
                                {statusCfg.icon}
                                {statusCfg.label}
                              </Badge>
                            </div>
                            <div className="flex flex-wrap gap-3 mt-2 text-xs text-muted-foreground">
                              <span>
                                Subscription:{" "}
                                <span className="font-medium text-foreground">
                                  {u.subscription?.status || "none"}
                                  {u.subscription?.cancel_at_period_end && " (cancelling)"}
                                </span>
                              </span>
                              <span>
                                Plan:{" "}
                                <span className="font-medium text-foreground">
                                  {u.subscription?.plan_id || "—"}
                                </span>
                              </span>
                              <span>
                                Repricer:{" "}
                                <span className={`font-medium ${u.repricer?.scheduler_enabled ? "text-green-600" : "text-muted-foreground"}`}>
                                  {u.repricer?.scheduler_enabled ? "ON" : "OFF"}
                                </span>
                              </span>
                              <span>
                                Amazon:{" "}
                                <span className={`font-medium ${activeAuths > 0 ? "text-green-600" : "text-muted-foreground"}`}>
                                  {activeAuths > 0 ? `${activeAuths} active` : "disconnected"}
                                </span>
                              </span>
                            </div>
                            {u.account_status_reason && u.account_status !== "active" && (
                              <p className="text-xs text-muted-foreground mt-1 italic">
                                Reason: {u.account_status_reason}
                              </p>
                            )}
                          </div>

                          {!isSelf && (
                            <div className="flex items-center gap-1 shrink-0">
                              {(u.account_status === "active" || u.account_status === "paused") && (
                                <>
                                  {u.account_status === "active" && (
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="text-yellow-600 hover:bg-yellow-50"
                                      onClick={() => setActionDialog({ action: "pause", user: u })}
                                    >
                                      <Pause className="h-3.5 w-3.5 mr-1" />
                                      Pause
                                    </Button>
                                  )}
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="text-red-600 hover:bg-red-50"
                                    onClick={() => setActionDialog({ action: "suspend", user: u })}
                                  >
                                    <Ban className="h-3.5 w-3.5 mr-1" />
                                    Suspend
                                  </Button>
                                </>
                              )}
                              {(u.account_status === "suspended" || u.account_status === "paused") && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="text-green-600 hover:bg-green-50"
                                  onClick={() => setActionDialog({ action: "restore", user: u })}
                                >
                                  <RotateCcw className="h-3.5 w-3.5 mr-1" />
                                  Restore
                                </Button>
                              )}
                              {u.account_status !== "deleted" && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="text-destructive hover:bg-destructive/10"
                                  onClick={() => setActionDialog({ action: "delete", user: u })}
                                >
                                  <Trash2 className="h-3.5 w-3.5 mr-1" />
                                  Delete
                                </Button>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </main>
      <Footer />

      {/* Confirmation Dialog */}
      <AlertDialog open={!!actionDialog} onOpenChange={(o) => { if (!o) { setActionDialog(null); setReason(""); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              {actionDialog?.action === "delete" && <AlertTriangle className="h-5 w-5 text-destructive" />}
              {actionDialog?.action === "suspend" && <Ban className="h-5 w-5 text-red-500" />}
              {getActionLabel(actionDialog?.action || "")}
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-3">
              <p>{getActionDescription(actionDialog?.action || "")}</p>
              <p className="font-medium text-foreground">
                User: {actionDialog?.user.email}
              </p>
              <div className="pt-2">
                <label className="text-sm font-medium text-foreground mb-1 block">
                  Reason (optional)
                </label>
                <Textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. Chargeback, abuse, requested by user…"
                  rows={2}
                />
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={acting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); executeAction(); }}
              disabled={acting}
              className={actionDialog?.action === "delete" || actionDialog?.action === "suspend" ? "bg-destructive hover:bg-destructive/90" : ""}
            >
              {acting && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Confirm {getActionLabel(actionDialog?.action || "")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
