import { useState, useEffect } from 'react';
import { MessageCircle, ChevronDown, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import AdminChatPanel from './AdminChatPanel';

interface PendingSession {
  id: string;
  user_email: string | null;
  user_name: string | null;
  created_at: string;
  status: string;
}

const AdminChatNotification = () => {
  const { user } = useAuth();
  const [isAdmin, setIsAdmin] = useState(false);
  const [sessions, setSessions] = useState<PendingSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!user) return;
    supabase.rpc('has_role', { _user_id: user.id, _role: 'admin' }).then(({ data }) => setIsAdmin(!!data));
  }, [user]);

  const fetchSessions = async () => {
    const { data } = await supabase
      .from('chat_sessions')
      .select('id, user_email, user_name, created_at, status')
      .in('status', ['pending', 'active'])
      .order('created_at', { ascending: true });
    if (data) setSessions(data);
  };

  useEffect(() => {
    if (!isAdmin) return;
    fetchSessions();
  }, [isAdmin, user]);

  useEffect(() => {
    if (!isAdmin) return;
    const ch = supabase
      .channel('admin-chat-sessions')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_sessions' }, () => fetchSessions())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [isAdmin]);

  const getMyName = async (): Promise<string> => {
    if (!user) return 'Admin';
    const { data } = await supabase
      .from('admin_profiles')
      .select('display_name')
      .eq('user_id', user.id)
      .maybeSingle();
    return data?.display_name || user.email?.split('@')[0] || 'Admin';
  };

  const joinChat = async (sessionId: string) => {
    if (!user) return;
    const name = await getMyName();
    // Update session to active if pending
    await supabase
      .from('chat_sessions')
      .update({ status: 'active', admin_id: user.id, accepted_at: new Date().toISOString() })
      .eq('id', sessionId);
    // Post system message
    await supabase.from('chat_messages').insert({
      session_id: sessionId,
      sender_id: null,
      sender_role: 'system',
      content: `${name} entered the chat`,
    });
    setActiveSessionId(sessionId);
    setOpen(false);
  };

  const leaveChat = async () => {
    if (!activeSessionId || !user) return;
    const name = await getMyName();
    // Post system message
    await supabase.from('chat_messages').insert({
      session_id: activeSessionId,
      sender_id: null,
      sender_role: 'system',
      content: `${name} left the chat`,
    });
    // Set session back to pending so other admins can pick it up
    await supabase
      .from('chat_sessions')
      .update({ status: 'pending', admin_id: null })
      .eq('id', activeSessionId);
    setActiveSessionId(null);
  };

  const endChat = async () => {
    if (!activeSessionId || !user) return;
    const name = await getMyName();
    await supabase.from('chat_messages').insert({
      session_id: activeSessionId,
      sender_id: null,
      sender_role: 'system',
      content: `${name} ended the chat`,
    });
    await supabase
      .from('chat_sessions')
      .update({ status: 'closed', closed_at: new Date().toISOString() })
      .eq('id', activeSessionId);
    setActiveSessionId(null);
  };

  if (!isAdmin) return null;

  const pendingSessions = sessions.filter(s => s.status === 'pending' && s.id !== activeSessionId);

  const timeAgo = (iso: string) => {
    const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    return `${Math.floor(mins / 60)}h ago`;
  };

  return (
    <>
      <div className="fixed top-4 left-4 z-[60]">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button className="relative flex items-center gap-1.5 rounded-full bg-card border border-border shadow-md px-3 py-1.5 hover:bg-accent transition-colors">
              <MessageCircle className="h-4 w-4 text-primary" />
              {pendingSessions.length > 0 && (
                <span className="absolute -top-1.5 -right-1.5 h-5 min-w-5 px-1 rounded-full bg-destructive text-destructive-foreground text-[10px] font-bold flex items-center justify-center animate-pulse">
                  {pendingSessions.length}
                </span>
              )}
              <span className="text-xs font-medium text-foreground">Chats</span>
              <ChevronDown className="h-3 w-3 text-muted-foreground" />
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-80 p-0" align="start" sideOffset={8}>
            <div className="px-4 py-3 border-b border-border">
              <h4 className="font-semibold text-sm text-foreground">Chat Requests</h4>
              <p className="text-xs text-muted-foreground">{pendingSessions.length} waiting</p>
            </div>
            {pendingSessions.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">No pending requests</div>
            ) : (
              <ScrollArea className="max-h-72">
                <div className="divide-y divide-border">
                  {pendingSessions.map((s) => (
                    <div key={s.id} className="px-4 py-3 flex items-center justify-between gap-3 hover:bg-accent/50 transition-colors">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-foreground truncate">{s.user_name || s.user_email || 'User'}</p>
                        <div className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Clock className="h-3 w-3" />
                          {timeAgo(s.created_at)}
                        </div>
                      </div>
                      <Button size="sm" className="h-7 text-xs shrink-0" onClick={() => joinChat(s.id)}>
                        Join
                      </Button>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}
          </PopoverContent>
        </Popover>
      </div>

      {activeSessionId && (
        <AdminChatPanel
          sessionId={activeSessionId}
          onLeave={leaveChat}
          onEnd={endChat}
        />
      )}
    </>
  );
};

export default AdminChatNotification;
