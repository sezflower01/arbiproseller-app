import { useState, useEffect, useRef } from 'react';
import { MessageCircle, X, Send, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';

interface ChatMessage {
  id: string;
  content: string;
  sender_role: 'user' | 'admin' | 'system';
  created_at: string;
}

interface AdminProfile {
  display_name: string;
  avatar_url: string | null;
}

const LiveChatWidget = () => {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionStatus, setSessionStatus] = useState<'pending' | 'active' | 'closed' | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [starting, setStarting] = useState(false);
  const [adminProfile, setAdminProfile] = useState<AdminProfile | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Listen for external open-support-chat events
  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener("open-support-chat", handler);
    return () => window.removeEventListener("open-support-chat", handler);
  }, []);

  // Check for existing open session on mount
  useEffect(() => {
    if (!user) return;
    const fetchSession = async () => {
      const { data } = await supabase
        .from('chat_sessions')
        .select('id, status')
        .eq('user_id', user.id)
        .in('status', ['pending', 'active'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (data) {
        setSessionId(data.id);
        setSessionStatus(data.status as 'pending' | 'active');
      }
    };
    fetchSession();
  }, [user]);

  // Load messages when session exists
  useEffect(() => {
    if (!sessionId) return;
    const load = async () => {
      const { data } = await supabase
        .from('chat_messages')
        .select('id, content, sender_role, created_at')
        .eq('session_id', sessionId)
        .order('created_at', { ascending: true });
      if (data) setMessages(data as ChatMessage[]);
    };
    load();
  }, [sessionId]);

  // Real-time messages
  useEffect(() => {
    if (!sessionId) return;
    const ch = supabase
      .channel(`chat-msg-${sessionId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages', filter: `session_id=eq.${sessionId}` },
        (payload) => {
          setMessages((prev) => {
            if (prev.some((m) => m.id === (payload.new as ChatMessage).id)) return prev;
            return [...prev, payload.new as ChatMessage];
          });
        })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [sessionId]);

  // Real-time session status
  useEffect(() => {
    if (!sessionId) return;
    const ch = supabase
      .channel(`chat-sess-${sessionId}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'chat_sessions', filter: `id=eq.${sessionId}` },
        (payload) => {
          const s = (payload.new as { status: string; admin_id?: string }).status;
          setSessionStatus(s as 'pending' | 'active' | 'closed');
          if (s === 'active') {
            const adminId = (payload.new as { admin_id?: string }).admin_id;
            if (adminId) fetchAdminProfile(adminId);
          }
          if (s === 'closed') {
            setSessionId(null);
            setMessages([]);
            setSessionStatus(null);
            setAdminProfile(null);
          }
        })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [sessionId]);

  // Fetch admin profile when session is active
  const fetchAdminProfile = async (adminId: string) => {
    const { data } = await supabase
      .from('admin_profiles')
      .select('display_name, avatar_url')
      .eq('user_id', adminId)
      .maybeSingle();
    if (data) setAdminProfile(data);
  };

  // If session already active on load, fetch admin profile
  useEffect(() => {
    if (!sessionId || sessionStatus !== 'active') return;
    supabase.from('chat_sessions').select('admin_id').eq('id', sessionId).single()
      .then(({ data }) => { if (data?.admin_id) fetchAdminProfile(data.admin_id); });
  }, [sessionId, sessionStatus]);

  // Auto-scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const startChat = async () => {
    if (!user) return;
    setStarting(true);
    const { data, error } = await supabase
      .from('chat_sessions')
      .insert({ user_id: user.id, user_email: user.email, user_name: user.user_metadata?.full_name || user.email })
      .select('id, status')
      .single();
    if (data && !error) {
      setSessionId(data.id);
      setSessionStatus(data.status as 'pending');
    }
    setStarting(false);
  };

  const sendMessage = async () => {
    if (!draft.trim() || !sessionId || !user) return;
    setSending(true);
    const content = draft.trim();
    setDraft('');
    await supabase.from('chat_messages').insert({
      session_id: sessionId,
      sender_id: user.id,
      sender_role: 'user',
      content,
    });
    setSending(false);
  };

  if (!user) return null;

  return (
    <>
      {/* Floating button */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="fixed bottom-6 right-6 z-50 h-14 w-14 rounded-full bg-primary text-primary-foreground shadow-xl flex items-center justify-center hover:scale-105 transition-transform"
          aria-label="Open live chat"
        >
          <MessageCircle className="h-6 w-6" />
          {sessionStatus === 'active' && (
            <span className="absolute -top-1 -right-1 h-4 w-4 rounded-full bg-green-500 border-2 border-background animate-pulse" />
          )}
        </button>
      )}

      {/* Chat window */}
      {open && (
        <div className="fixed bottom-6 right-6 z-50 w-[380px] max-w-[calc(100vw-2rem)] rounded-2xl border border-border bg-card shadow-2xl flex flex-col overflow-hidden"
          style={{ height: 520 }}>
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 bg-primary text-primary-foreground rounded-t-2xl">
            <div className="flex items-center gap-2.5">
              {sessionStatus === 'active' && adminProfile ? (
                <Avatar className="h-8 w-8 border-2 border-primary-foreground/30">
                  {adminProfile.avatar_url && <AvatarImage src={adminProfile.avatar_url} />}
                  <AvatarFallback className="bg-primary-foreground/20 text-primary-foreground text-xs font-bold">
                    {adminProfile.display_name?.[0]?.toUpperCase() || '?'}
                  </AvatarFallback>
                </Avatar>
              ) : (
                <MessageCircle className="h-5 w-5" />
              )}
              <div>
                <p className="font-semibold text-sm">
                  {sessionStatus === 'active' && adminProfile?.display_name ? adminProfile.display_name : 'Live Support'}
                </p>
                <p className="text-xs opacity-80">
                  {sessionStatus === 'active' ? 'Online' : sessionStatus === 'pending' ? 'Waiting for agent…' : 'Start a conversation'}
                </p>
              </div>
            </div>
            <button onClick={() => setOpen(false)} className="hover:opacity-80"><X className="h-5 w-5" /></button>
          </div>

          {/* Body */}
          {!sessionId ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-4 p-6 text-center">
              <div className="h-16 w-16 rounded-full bg-primary/10 flex items-center justify-center">
                <MessageCircle className="h-8 w-8 text-primary" />
              </div>
              <h3 className="font-semibold text-foreground">Need help?</h3>
              <p className="text-sm text-muted-foreground">Start a live chat and one of our team members will be with you shortly.</p>
              <Button onClick={startChat} disabled={starting} className="w-full">
                {starting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Start Chat
              </Button>
            </div>
          ) : (
            <>
              {sessionStatus === 'pending' && (
                <div className="px-4 py-2 bg-yellow-50 dark:bg-yellow-900/20 text-yellow-700 dark:text-yellow-300 text-xs text-center border-b border-border">
                  ⏳ Waiting for an agent to accept your chat…
                </div>
              )}
              <ScrollArea className="flex-1 px-4 py-3">
                <div className="space-y-3">
                  {messages.map((m) => {
                    if (m.sender_role === 'system') {
                      return (
                        <div key={m.id} className="flex justify-center">
                          <span className="text-[11px] text-muted-foreground bg-muted/60 px-3 py-1 rounded-full">
                            {m.content}
                          </span>
                        </div>
                      );
                    }
                    return (
                      <div key={m.id} className={cn('flex', m.sender_role === 'user' ? 'justify-end' : 'justify-start')}>
                        <div className={cn(
                          'max-w-[75%] rounded-2xl px-3.5 py-2 text-sm',
                          m.sender_role === 'user'
                            ? 'bg-primary text-primary-foreground rounded-br-md'
                            : 'bg-muted text-foreground rounded-bl-md'
                        )}>
                          {m.content}
                          <span className="block text-[10px] mt-1 opacity-60">
                            {new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                  <div ref={bottomRef} />
                </div>
              </ScrollArea>

              {/* Input */}
              <div className="p-3 border-t border-border flex gap-2">
                <Input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
                  placeholder={sessionStatus === 'pending' ? 'Type ahead, agent will see it…' : 'Type a message…'}
                  className="flex-1 rounded-full text-sm h-9"
                />
                <Button size="icon" className="h-9 w-9 rounded-full shrink-0" onClick={sendMessage} disabled={!draft.trim() || sending}>
                  <Send className="h-4 w-4" />
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
};

export default LiveChatWidget;
