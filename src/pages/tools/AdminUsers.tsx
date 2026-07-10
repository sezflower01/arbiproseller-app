import { useEffect, useMemo, useState } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { useModuleAccess, type AppModule, type AppAction } from "@/hooks/useModuleAccess";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { Loader2, Shield, Search, History, Settings2 } from "lucide-react";
import { Switch } from "@/components/ui/switch";

type Role = "admin" | "user" | "viewer";
type Grant = { module: AppModule; action: AppAction };
type ManagedUser = {
  id: string;
  email: string;
  created_at: string;
  last_sign_in_at: string | null;
  banned_until: string | null;
  role: Role;
  grants: Grant[];
  is_approved: boolean;
};

const MODULES: { key: AppModule; label: string }[] = [
  { key: "repricer", label: "Repricer" },
  { key: "inventory", label: "Inventory" },
  { key: "reports", label: "Reports / Sales" },
  { key: "supplier_discovery", label: "Supplier Discovery" },
  { key: "product_library", label: "Product Library" },
  { key: "personalhour", label: "PersonalHour" },
  { key: "fba_builder", label: "FBA Shipment Builder" },
  { key: "profit_loss", label: "Profit & Loss" },
  { key: "buy_again", label: "Need to Buy Again" },
  { key: "still_thinking", label: "Still Thinking" },
  { key: "mobile_live_sales", label: "Mobile Live Sales" },
  { key: "mobile_inventory_valuation", label: "Mobile Inventory Valuation" },
  { key: "upc_scanner", label: "UPC Scanner (Mobile)" },
  { key: "scan_history", label: "Scan History (Mobile)" },
  { key: "settings", label: "Settings" },
  { key: "admin_panel", label: "Admin Panel" },
];
const ACTIONS: AppAction[] = ["view", "run", "edit", "admin"];

// Default starter access granted to new non-admin signups (and backfilled
// for users with zero grants). All modules get view/run/edit by default;
// admin action is reserved for admins.
const DEFAULT_GRANT_MODULES: string[] = [
  "repricer", "inventory", "reports", "supplier_discovery", "product_library",
  "personalhour", "fba_builder", "profit_loss", "buy_again", "still_thinking",
  "mobile_live_sales", "mobile_inventory_valuation", "upc_scanner", "scan_history",
  "settings",
];
const DEFAULT_GRANT_KEYS: string[] = DEFAULT_GRANT_MODULES.flatMap((m) => [
  `${m}:view`, `${m}:run`, `${m}:edit`,
]);

export default function AdminUsers() {
  const { user, loading: authLoading } = useAuth();
  const { isAdmin, loading: accessLoading } = useModuleAccess();

  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<"all" | Role>("all");
  const [editingUser, setEditingUser] = useState<ManagedUser | null>(null);
  const [editingGrants, setEditingGrants] = useState<Set<string>>(new Set());
  const [savingGrants, setSavingGrants] = useState(false);
  const [selfDemoteOpen, setSelfDemoteOpen] = useState<{ target: ManagedUser; new_role: Role } | null>(null);
  const [promoteOpen, setPromoteOpen] = useState<{ target: ManagedUser } | null>(null);
  const [auditOpen, setAuditOpen] = useState(false);
  const [auditEntries, setAuditEntries] = useState<any[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);

  const loadUsers = async () => {
    setLoading(true);
    const { data, error } = await supabase.functions.invoke("admin-user-permissions", {
      body: { action: "list_users" },
    });
    if (error) { toast.error(error.message || "Failed to load users"); setLoading(false); return; }
    setUsers(data?.users || []);
    setLoading(false);
  };

  useEffect(() => {
    if (isAdmin) loadUsers();
  }, [isAdmin]);

  const filtered = useMemo(() => {
    return users.filter((u) => {
      if (roleFilter !== "all" && u.role !== roleFilter) return false;
      if (search && !u.email?.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [users, search, roleFilter]);

  const setRole = async (target: ManagedUser, new_role: Role, confirm_self_demote = false) => {
    const { data, error } = await supabase.functions.invoke("admin-user-permissions", {
      body: { action: "set_role", target_user_id: target.id, new_role, confirm_self_demote },
    });
    if (error) {
      // Try to surface self-demote error
      const msg = (error as any)?.message || "";
      if (msg.includes("self_demote") || (data as any)?.error === "self_demote_requires_confirmation") {
        setSelfDemoteOpen({ target, new_role });
        return;
      }
      toast.error(msg || "Failed to update role");
      return;
    }
    if ((data as any)?.error === "self_demote_requires_confirmation") {
      setSelfDemoteOpen({ target, new_role });
      return;
    }
    toast.success(`Role updated to ${new_role}`);
    loadUsers();
  };

  const handleRoleChange = (target: ManagedUser, new_role: Role) => {
    if (new_role === target.role) return;
    if (target.id === user?.id && new_role !== "admin") {
      setSelfDemoteOpen({ target, new_role });
      return;
    }
    if (new_role === "admin" && target.role !== "admin") {
      setPromoteOpen({ target });
      return;
    }
    setRole(target, new_role);
  };

  const openGrantsEditor = (u: ManagedUser) => {
    setEditingUser(u);
    setEditingGrants(new Set(u.grants.map((g) => `${g.module}:${g.action}`)));
  };

  const toggleGrant = (module: AppModule, action: AppAction) => {
    const key = `${module}:${action}`;
    setEditingGrants((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const saveGrants = async () => {
    if (!editingUser) return;
    setSavingGrants(true);
    const grants: Grant[] = Array.from(editingGrants).map((k) => {
      const [module, action] = k.split(":");
      return { module: module as AppModule, action: action as AppAction };
    });
    const { error } = await supabase.functions.invoke("admin-user-permissions", {
      body: { action: "set_module_access", target_user_id: editingUser.id, grants },
    });
    setSavingGrants(false);
    if (error) { toast.error(error.message || "Failed to save permissions"); return; }
    toast.success("Permissions updated");
    setEditingUser(null);
    loadUsers();
  };

  const setApproval = async (target: ManagedUser, approved: boolean) => {
    // optimistic
    setUsers((prev) => prev.map((u) => (u.id === target.id ? { ...u, is_approved: approved } : u)));
    const { error } = await supabase.functions.invoke("admin-user-permissions", {
      body: { action: "set_approval", target_user_id: target.id, approved },
    });
    if (error) {
      toast.error(error.message || "Failed to update approval");
      loadUsers();
      return;
    }
    toast.success(approved ? `Access granted to ${target.email}` : `Access revoked for ${target.email}`);
  };

  const openAudit = async () => {
    setAuditOpen(true);
    setAuditLoading(true);
    const { data, error } = await supabase.functions.invoke("admin-user-permissions", {
      body: { action: "list_audit", limit: 100 },
    });
    setAuditLoading(false);
    if (error) { toast.error(error.message || "Failed to load audit log"); return; }
    setAuditEntries(data?.entries || []);
  };

  if (authLoading || accessLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  if (!isAdmin) return <Navigate to="/tools" replace />;

  return (
    <div className="container mx-auto p-6 max-w-7xl">
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Shield className="h-6 w-6 text-primary" />
            User Access Management
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage roles and per-module permissions. Admins have full access by default.
          </p>
        </div>
        <Button variant="outline" onClick={openAudit}>
          <History className="h-4 w-4 mr-2" />
          Audit Log
        </Button>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3 flex-wrap">
          <CardTitle className="text-base">Users ({filtered.length})</CardTitle>
          <div className="flex gap-2 items-center flex-wrap">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search email…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8 w-64"
              />
            </div>
            <Select value={roleFilter} onValueChange={(v) => setRoleFilter(v as any)}>
              <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All roles</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
                <SelectItem value="user">User</SelectItem>
                <SelectItem value="viewer">Viewer</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={loadUsers} disabled={loading}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Refresh"}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="py-12 flex justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Modules granted</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((u) => {
                  const isMe = u.id === user.id;
                  const banned = u.banned_until && new Date(u.banned_until) > new Date();
                  return (
                    <TableRow key={u.id}>
                      <TableCell className="font-medium">
                        {u.email}
                        {isMe && <Badge variant="outline" className="ml-2 text-xs">You</Badge>}
                        <div className="text-xs text-muted-foreground font-mono">{u.id.slice(0, 8)}…</div>
                      </TableCell>
                      <TableCell>
                        <Select value={u.role} onValueChange={(v) => handleRoleChange(u, v as Role)}>
                          <SelectTrigger className="w-32 h-8"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="admin">Admin</SelectItem>
                            <SelectItem value="user">User</SelectItem>
                            <SelectItem value="viewer">Viewer</SelectItem>
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        {u.role === "admin" ? (
                          <Badge variant="secondary">Full access (admin)</Badge>
                        ) : u.grants.length === 0 ? (
                          <span className="text-xs text-muted-foreground">None</span>
                        ) : (
                          <span className="text-xs">
                            {u.grants.length} grant{u.grants.length === 1 ? "" : "s"}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        {banned ? (
                          <Badge variant="destructive">Suspended</Badge>
                        ) : u.role !== "admin" && !u.is_approved ? (
                          <div className="flex items-center gap-2">
                            <Badge variant="destructive">Restricted</Badge>
                            <Switch
                              checked={false}
                              onCheckedChange={() => setApproval(u, true)}
                              aria-label="Grant access"
                            />
                            <span className="text-xs text-muted-foreground">Grant</span>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2">
                            <Badge variant="outline">Active</Badge>
                            {u.role !== "admin" && !isMe && (
                              <Switch
                                checked={true}
                                onCheckedChange={() => setApproval(u, false)}
                                aria-label="Revoke access"
                              />
                            )}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => openGrantsEditor(u)}
                          disabled={u.role === "admin"}
                          title={u.role === "admin" ? "Admins already have full access" : "Edit module permissions"}
                        >
                          <Settings2 className="h-4 w-4 mr-1" />
                          Permissions
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {filtered.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">
                      No users match your filters.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Permissions editor */}
      <Dialog open={!!editingUser} onOpenChange={(o) => !o && setEditingUser(null)}>
        <DialogContent
          className="max-w-2xl"
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>Module permissions — {editingUser?.email}</DialogTitle>
            <DialogDescription>
              Tick the actions this user can perform per module. Backend functions enforce these checks.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center justify-between gap-2 -mt-2 mb-1 flex-wrap">
            <p className="text-xs text-muted-foreground">
              Default starter access: all modules with view + run + edit (admin action reserved for admins).
            </p>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => setEditingGrants(new Set(DEFAULT_GRANT_KEYS))}
            >
              Apply defaults
            </Button>
          </div>
          <div className="overflow-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-2 font-medium">Module</th>
                  {ACTIONS.map((a) => (
                    <th key={a} className="text-center py-2 font-medium capitalize">{a}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {MODULES.map((m) => (
                  <tr key={m.key} className="border-b last:border-0">
                    <td className="py-2">{m.label}</td>
                    {ACTIONS.map((a) => {
                      const key = `${m.key}:${a}`;
                      return (
                        <td key={a} className="text-center py-2">
                          <Checkbox
                            checked={editingGrants.has(key)}
                            onCheckedChange={() => toggleGrant(m.key, a)}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingUser(null)}>Cancel</Button>
            <Button onClick={saveGrants} disabled={savingGrants}>
              {savingGrants && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Save permissions
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Promote-to-admin confirm */}
      <AlertDialog open={!!promoteOpen} onOpenChange={(o) => !o && setPromoteOpen(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Promote to admin?</AlertDialogTitle>
            <AlertDialogDescription>
              <strong>{promoteOpen?.target.email}</strong> will receive full access to every module, tool, and admin function. This action is logged.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (promoteOpen) setRole(promoteOpen.target, "admin");
                setPromoteOpen(null);
              }}
            >
              Yes, make admin
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Self-demote confirm */}
      <AlertDialog open={!!selfDemoteOpen} onOpenChange={(o) => !o && setSelfDemoteOpen(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove your own admin access?</AlertDialogTitle>
            <AlertDialogDescription>
              You are about to change your own role to <strong>{selfDemoteOpen?.new_role}</strong>. You will lose access to this admin page and may be locked out of admin tools. Continue?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (selfDemoteOpen) setRole(selfDemoteOpen.target, selfDemoteOpen.new_role, true);
                setSelfDemoteOpen(null);
              }}
            >
              Yes, remove my admin
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Audit log */}
      <Dialog open={auditOpen} onOpenChange={setAuditOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Admin audit log</DialogTitle>
            <DialogDescription>Recent role and permission changes (last 100).</DialogDescription>
          </DialogHeader>
          {auditLoading ? (
            <div className="py-8 flex justify-center"><Loader2 className="h-5 w-5 animate-spin" /></div>
          ) : (
            <div className="max-h-[60vh] overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Actor</TableHead>
                    <TableHead>Target</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Details</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {auditEntries.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell className="text-xs whitespace-nowrap">
                        {new Date(e.created_at).toLocaleString()}
                      </TableCell>
                      <TableCell className="text-xs">{e.actor_email}</TableCell>
                      <TableCell className="text-xs">{e.target_email}</TableCell>
                      <TableCell><Badge variant="outline">{e.action}</Badge></TableCell>
                      <TableCell className="text-xs font-mono">
                        {e.action === "role_change"
                          ? `${e.details?.old_role} → ${e.details?.new_role}`
                          : `${(e.details?.new || []).length} grant(s)`}
                      </TableCell>
                    </TableRow>
                  ))}
                  {auditEntries.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center py-6 text-muted-foreground">
                        No audit entries yet.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
