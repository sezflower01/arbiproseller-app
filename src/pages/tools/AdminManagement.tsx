import { useState, useEffect } from 'react';
import { Helmet } from 'react-helmet-async';
import Navbar from '@/components/Navbar';
import Footer from '@/components/Footer';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useSubscription } from '@/hooks/use-subscription';
import { toast } from 'sonner';
import { Shield, UserPlus, Trash2, Loader2, Save, Camera, Users } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import AccountControlPanel from '@/components/admin/AccountControlPanel';

interface AdminUser {
  user_id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
}

const AVATAR_OPTIONS = [
  ...Array.from({ length: 6 }, (_, i) => `https://api.dicebear.com/9.x/adventurer/svg?seed=admin${i + 1}`),
  ...Array.from({ length: 6 }, (_, i) => `https://api.dicebear.com/9.x/avataaars/svg?seed=team${i + 1}`),
  ...Array.from({ length: 6 }, (_, i) => `https://api.dicebear.com/9.x/bottts/svg?seed=bot${i + 1}`),
  ...Array.from({ length: 6 }, (_, i) => `https://api.dicebear.com/9.x/lorelei/svg?seed=support${i + 1}`),
  ...Array.from({ length: 6 }, (_, i) => `https://api.dicebear.com/9.x/fun-emoji/svg?seed=fun${i + 1}`),
];

const AdminManagement = () => {
  const { user } = useAuth();
  const { isAdmin, loading: subLoading } = useSubscription();
  const navigate = useNavigate();
  const [admins, setAdmins] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [newEmail, setNewEmail] = useState('');
  const [adding, setAdding] = useState(false);
  const [myName, setMyName] = useState('');
  const [myAvatar, setMyAvatar] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (subLoading) return;
    if (!isAdmin) { navigate('/tools'); return; }
    loadAdmins();
    loadMyProfile();
  }, [isAdmin, subLoading]);

  const loadAdmins = async () => {
    setLoading(true);
    const { data, error } = await supabase.functions.invoke('admin-manage-roles', {
      body: { action: 'list_admins' },
    });
    if (!error && data?.admins) setAdmins(data.admins);
    setLoading(false);
  };

  const loadMyProfile = async () => {
    if (!user) return;
    const { data } = await supabase
      .from('admin_profiles')
      .select('display_name, avatar_url')
      .eq('user_id', user.id)
      .maybeSingle();
    if (data) {
      setMyName(data.display_name || '');
      setMyAvatar(data.avatar_url || '');
    }
  };

  const saveMyProfile = async () => {
    if (!user) return;
    setSaving(true);
    const { error } = await supabase
      .from('admin_profiles')
      .upsert({ user_id: user.id, display_name: myName, avatar_url: myAvatar || null }, { onConflict: 'user_id' });
    if (error) toast.error('Failed to save profile');
    else { toast.success('Profile saved'); loadAdmins(); }
    setSaving(false);
  };

  const addAdmin = async () => {
    if (!newEmail.trim()) return;
    setAdding(true);
    const { data, error } = await supabase.functions.invoke('admin-manage-roles', {
      body: { action: 'add_role', email: newEmail.trim(), role: 'admin' },
    });
    if (error || data?.error) toast.error(data?.error || 'Failed to add admin');
    else { toast.success(data?.message || 'Admin added successfully'); setNewEmail(''); loadAdmins(); }
    setAdding(false);
  };

  const removeAdmin = async (email: string) => {
    const { data, error } = await supabase.functions.invoke('admin-manage-roles', {
      body: { action: 'remove_role', email, role: 'admin' },
    });
    if (error || data?.error) toast.error(data?.error || 'Failed to remove admin');
    else { toast.success('Admin removed'); loadAdmins(); }
  };

  if (!isAdmin) return null;

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <Helmet><title>Admin Management</title></Helmet>
      <Navbar />
      <main className="flex-grow pt-24 pb-16">
        <div className="container mx-auto px-4 max-w-5xl">
          <Tabs defaultValue="roles" className="space-y-6">
            <TabsList>
              <TabsTrigger value="roles" className="flex items-center gap-1.5">
                <Shield className="h-4 w-4" />
                Admin Roles
              </TabsTrigger>
              <TabsTrigger value="accounts" className="flex items-center gap-1.5">
                <Users className="h-4 w-4" />
                Account Control
              </TabsTrigger>
            </TabsList>

            <TabsContent value="roles" className="space-y-8">
              {/* My Admin Profile */}
              <Card>
                <CardHeader>
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center">
                      <Camera className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <CardTitle className="text-xl">My Admin Profile</CardTitle>
                      <CardDescription>Set your display name and avatar for live chat</CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-5">
                  <div className="flex items-center gap-4">
                    <Avatar className="h-16 w-16 border-2 border-primary/20">
                      {myAvatar && <AvatarImage src={myAvatar} />}
                      <AvatarFallback className="text-lg font-semibold bg-primary/10 text-primary">
                        {myName ? myName[0].toUpperCase() : user?.email?.[0]?.toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1">
                      <label className="text-sm font-medium text-foreground mb-1 block">Display Name</label>
                      <Input value={myName} onChange={(e) => setMyName(e.target.value)} placeholder="e.g. Bassam" />
                    </div>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-foreground mb-2 block">Choose an Avatar</label>
                    <div className="grid grid-cols-10 gap-2">
                      {AVATAR_OPTIONS.map((url, i) => (
                        <button
                          key={i}
                          onClick={() => setMyAvatar(url)}
                          className={`rounded-full overflow-hidden border-2 transition-all hover:scale-110 ${myAvatar === url ? 'border-primary ring-2 ring-primary/30 scale-110' : 'border-border hover:border-primary/50'}`}
                        >
                          <img src={url} alt={`Avatar ${i + 1}`} className="h-10 w-10" />
                        </button>
                      ))}
                    </div>
                    {myAvatar && (
                      <button onClick={() => setMyAvatar('')} className="text-xs text-muted-foreground hover:text-foreground mt-2 underline">
                        Clear avatar
                      </button>
                    )}
                  </div>
                  <Button onClick={saveMyProfile} disabled={saving} className="w-full">
                    {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Save className="h-4 w-4 mr-2" />}
                    Save Profile
                  </Button>
                </CardContent>
              </Card>

              {/* Manage Admins */}
              <Card>
                <CardHeader>
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center">
                      <Shield className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <CardTitle className="text-xl">Manage Admins</CardTitle>
                      <CardDescription>Add or remove admin users by email</CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="flex gap-2">
                    <Input
                      value={newEmail}
                      onChange={(e) => setNewEmail(e.target.value)}
                      placeholder="Enter user email to make admin…"
                      onKeyDown={(e) => { if (e.key === 'Enter') addAdmin(); }}
                      className="flex-1"
                    />
                    <Button onClick={addAdmin} disabled={adding || !newEmail.trim()}>
                      {adding ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <UserPlus className="h-4 w-4 mr-2" />}
                      Add Admin
                    </Button>
                  </div>
                  <Separator />
                  {loading ? (
                    <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
                  ) : admins.length === 0 ? (
                    <p className="text-center text-muted-foreground py-4">No admins found</p>
                  ) : (
                    <div className="space-y-3">
                      {admins.map((a) => (
                        <div key={a.user_id} className="flex items-center justify-between gap-3 p-3 rounded-xl border border-border bg-card hover:bg-accent/30 transition-colors">
                          <div className="flex items-center gap-3 min-w-0">
                            <Avatar className="h-10 w-10 shrink-0">
                              {a.avatar_url && <AvatarImage src={a.avatar_url} />}
                              <AvatarFallback className="bg-primary/10 text-primary font-semibold">
                                {a.display_name ? a.display_name[0].toUpperCase() : a.email[0].toUpperCase()}
                              </AvatarFallback>
                            </Avatar>
                            <div className="min-w-0">
                              <p className="font-medium text-sm text-foreground truncate">
                                {a.display_name || 'No name set'}
                                {a.user_id === user?.id && <span className="ml-2 text-xs text-primary">(You)</span>}
                              </p>
                              <p className="text-xs text-muted-foreground truncate">{a.email}</p>
                            </div>
                          </div>
                          {a.user_id !== user?.id && (
                            <Button variant="ghost" size="icon" className="shrink-0 text-destructive hover:bg-destructive/10" onClick={() => removeAdmin(a.email)}>
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="accounts">
              <AccountControlPanel />
            </TabsContent>
          </Tabs>
        </div>
      </main>
      <Footer />
    </div>
  );
};

export default AdminManagement;
