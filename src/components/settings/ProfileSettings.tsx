import { useState, useEffect } from "react";
import { User, Crown, UserPlus, Trash2, Mail } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface TeamMember {
  id: string;
  email: string;
  role: string;
  status: string;
  invited_at: string;
}

export default function ProfileSettings() {
  const { user } = useAuth();
  const [displayName, setDisplayName] = useState("");
  const [savedName, setSavedName] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Team members
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<string>("viewer");
  const [inviting, setInviting] = useState(false);
  const [loadingTeam, setLoadingTeam] = useState(true);

  useEffect(() => {
    if (!user) return;
    const metaName = user.user_metadata?.full_name || user.user_metadata?.name || "";
    setDisplayName(metaName);
    setSavedName(metaName);
    setLoading(false);
  }, [user]);

  useEffect(() => {
    if (!user) return;
    fetchTeamMembers();
  }, [user]);

  const fetchTeamMembers = async () => {
    if (!user) return;
    setLoadingTeam(true);
    const { data, error } = await supabase
      .from("team_members")
      .select("*")
      .eq("owner_id", user.id)
      .order("invited_at", { ascending: false });

    if (!error && data) {
      setTeamMembers(data as TeamMember[]);
    }
    setLoadingTeam(false);
  };

  const handleSave = async () => {
    if (!user) return;
    setSaving(true);
    const { error } = await supabase.auth.updateUser({
      data: { full_name: displayName.trim() },
    });
    if (error) {
      toast.error("Failed to save profile");
    } else {
      setSavedName(displayName.trim());
      toast.success("Profile updated");
    }
    setSaving(false);
  };

  const handleInvite = async () => {
    if (!user || !inviteEmail.trim()) return;
    const email = inviteEmail.trim().toLowerCase();

    if (email === user.email?.toLowerCase()) {
      toast.error("You can't invite yourself");
      return;
    }

    setInviting(true);
    const { error } = await supabase.from("team_members").insert({
      owner_id: user.id,
      email,
      role: inviteRole as any,
      status: "pending" as any,
    });

    if (error) {
      if (error.code === "23505") {
        toast.error("This email has already been invited");
      } else {
        toast.error("Failed to send invite");
        console.error(error);
      }
    } else {
      toast.success(`Invitation sent to ${email}`);
      setInviteEmail("");
      setInviteRole("viewer");
      fetchTeamMembers();
    }
    setInviting(false);
  };

  const handleRemoveMember = async (id: string) => {
    const { error } = await supabase.from("team_members").delete().eq("id", id);
    if (error) {
      toast.error("Failed to remove member");
    } else {
      toast.success("Member removed");
      setTeamMembers((prev) => prev.filter((m) => m.id !== id));
    }
  };

  const hasChanges = displayName.trim() !== savedName;

  const roleBadgeColor = (role: string) => {
    switch (role) {
      case "admin": return "bg-blue-500/20 text-blue-400 border-blue-500/30";
      case "manager": return "bg-amber-500/20 text-amber-400 border-amber-500/30";
      case "viewer": return "bg-gray-500/20 text-gray-400 border-gray-500/30";
      default: return "bg-gray-500/20 text-gray-400 border-gray-500/30";
    }
  };

  const statusBadgeColor = (status: string) => {
    switch (status) {
      case "accepted": return "bg-emerald-500/20 text-emerald-400 border-emerald-500/30";
      case "pending": return "bg-yellow-500/20 text-yellow-400 border-yellow-500/30";
      case "revoked": return "bg-red-500/20 text-red-400 border-red-500/30";
      default: return "bg-gray-500/20 text-gray-400 border-gray-500/30";
    }
  };

  return (
    <div className="space-y-8">
      {/* Profile Section */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <User className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-bold text-white">Profile</h2>
        </div>
        <p className="text-sm text-gray-400">Your account information.</p>
      </div>

      <div className="rounded-xl border border-white/10 bg-white/5 backdrop-blur-sm p-5 space-y-5">
        {loading ? (
          <div className="h-16 flex items-center justify-center text-sm text-gray-400">Loading...</div>
        ) : (
          <>
            {/* Owner Badge */}
            <div className="flex items-center gap-3 p-3 rounded-lg bg-primary/10 border border-primary/20">
              <Crown className="h-5 w-5 text-primary" />
              <div className="flex-1">
                <p className="text-sm font-semibold text-white">Account Owner</p>
                <p className="text-xs text-gray-400">You created this account and can manage all users and settings.</p>
              </div>
              <Badge variant="outline" className="bg-primary/20 text-primary border-primary/30 font-semibold">
                Owner
              </Badge>
            </div>

            <div className="space-y-2">
              <Label htmlFor="email" className="text-gray-300 font-semibold text-sm">Email</Label>
              <Input id="email" value={user?.email || ""} disabled className="bg-white/5 border-white/10 text-white font-medium" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="displayName" className="text-gray-300 font-semibold text-sm">Name</Label>
              <Input
                id="displayName"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Enter your name"
                className="bg-white/5 border-white/10 text-white font-medium placeholder:text-gray-500"
              />
            </div>
            <div className="flex justify-end pt-2">
              <Button onClick={handleSave} disabled={!hasChanges || saving} size="sm">
                {saving ? "Saving..." : "Save"}
              </Button>
            </div>
          </>
        )}
      </div>

      {/* Team Members Section */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <UserPlus className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-bold text-white">Team Members</h2>
        </div>
        <p className="text-sm text-gray-400">Invite users to access your account with custom roles.</p>
      </div>

      <div className="rounded-xl border border-white/10 bg-white/5 backdrop-blur-sm p-5 space-y-5">
        {/* Invite Form */}
        <div className="space-y-3">
          <Label className="text-gray-300 font-semibold text-sm">Invite New Member</Label>
          <div className="flex gap-2">
            <div className="flex-1">
              <Input
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="Email address"
                className="bg-white/5 border-white/10 text-white font-medium placeholder:text-gray-500"
              />
            </div>
            <Select value={inviteRole} onValueChange={setInviteRole}>
              <SelectTrigger className="w-32 bg-white/5 border-white/10 text-white">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-[hsl(222,84%,6%)] border-white/10">
                <SelectItem value="admin">Admin</SelectItem>
                <SelectItem value="manager">Manager</SelectItem>
                <SelectItem value="viewer">Viewer</SelectItem>
              </SelectContent>
            </Select>
            <Button onClick={handleInvite} disabled={!inviteEmail.trim() || inviting} size="sm" className="gap-1.5">
              <Mail className="h-3.5 w-3.5" />
              {inviting ? "Sending..." : "Invite"}
            </Button>
          </div>
          <p className="text-xs text-gray-500">
            <strong>Admin</strong> — Same access as Owner, including managing users &nbsp;·&nbsp;
            <strong>Manager</strong> — Full access to all features &nbsp;·&nbsp;
            <strong>Viewer</strong> — Read-only access
          </p>
        </div>

        {/* Members List */}
        <div className="space-y-2">
          {loadingTeam ? (
            <div className="h-12 flex items-center justify-center text-sm text-gray-400">Loading team...</div>
          ) : teamMembers.length === 0 ? (
            <div className="text-center py-6 text-sm text-gray-500">
              No team members yet. Invite someone above to get started.
            </div>
          ) : (
            teamMembers.map((member) => (
              <div
                key={member.id}
                className="flex items-center justify-between p-3 rounded-lg bg-white/[0.03] border border-white/5 hover:border-white/10 transition-colors"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/10 text-xs font-bold text-gray-300">
                    {member.email.charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-white truncate">{member.email}</p>
                    <p className="text-xs text-gray-500">
                      Invited {new Date(member.invited_at).toLocaleDateString()}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className={`text-[11px] capitalize ${roleBadgeColor(member.role)}`}>
                    {member.role}
                  </Badge>
                  <Badge variant="outline" className={`text-[11px] capitalize ${statusBadgeColor(member.status)}`}>
                    {member.status}
                  </Badge>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-gray-500 hover:text-red-400 hover:bg-red-500/10"
                    onClick={() => handleRemoveMember(member.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
