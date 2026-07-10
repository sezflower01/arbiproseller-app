import { useState, useEffect, useRef } from 'react';
import { X, Send, Loader2, User, LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';

interface ChatMessage {
  id: string;
  content: string;
  sender_role: 'user' | 'admin' | 'system';
  created_at: string;
}

interface Props {
  sessionId: string;
  onLeave: () => void;
  onEnd: () => void;
}

const AdminChatPanel = ({ sessionId, onLeave, onEnd }: Props) => {
  const { user } = useAuth();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [customerInfo, setCustomerInfo] = useState<{ email: string | null; name: string | null }>({ email: null, name: null });
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    supabase.from('chat_sessions').select('user_email, user_name').eq('id', sessionId).single()
      .then(({ data }) => { if (data) setCustomerInfo({ email: data.user_email, name: data.user_name }); });
  }, [sessionId]);

  useEffect(() => {
    supabase.from('chat_messages').select('id, content, sender_role, created_at')
      .eq('session_id', sessionId).order('created_at', { ascending: true })
      .then(({ data }) => { if (data) setMessages(data as ChatMessage[]); });
  }, [sessionId]);

  useEffect(() => {
    const ch = supabase
      .channel(`admin-chat-msg-${sessionId}`)
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

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendMessage = async () => {
    if (!draft.trim() || !user) return;
    setSending(true);
    const content = draft.trim();
    setDraft('');
    await supabase.from('chat_messages').insert({
      session_id: sessionId,
      sender_id: user.id,
      sender_role: 'admin',
      content,
    });
    setSending(false);
  };

  return (
    <div className="fixed bottom-6 right-6 z-[55] w-[400px] max-w-[calc(100vw-2rem)] rounded-2xl border border-border bg-card shadow-2xl flex flex-col overflow-hidden"
      style={{ height: 540 }}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-gradient-to-r from-emerald-600 to-teal-600 text-white rounded-t-2xl">
        <div className="flex items-center gap-3 min-w-0">
          <div className="h-8 w-8 rounded-full bg-white/20 flex items-center justify-center shrink-0">
            <User className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="font-semibold text-sm truncate">{customerInfo.name || 'Customer'}</p>
            <p className="text-xs opacity-80 truncate">{customerInfo.email}</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" className="h-7 text-xs text-white hover:bg-white/20 gap-1" onClick={onLeave}>
            <LogOut className="h-3 w-3" /> Leave
          </Button>
          <Button size="sm" variant="ghost" className="h-7 text-xs text-white hover:bg-white/20" onClick={onEnd}>
            End
          </Button>
          <button onClick={onLeave} className="hover:opacity-80 ml-1"><X className="h-4 w-4" /></button>
        </div>
      </div>

      {/* Messages */}
      <ScrollArea className="flex-1 px-4 py-3">
        <div className="space-y-3">
          {messages.length === 0 && (
            <p className="text-center text-muted-foreground text-sm py-8">No messages yet. Say hello! 👋</p>
          )}
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
              <div key={m.id} className={cn('flex', m.sender_role === 'admin' ? 'justify-end' : 'justify-start')}>
                <div className={cn(
                  'max-w-[75%] rounded-2xl px-3.5 py-2 text-sm',
                  m.sender_role === 'admin'
                    ? 'bg-emerald-600 text-white rounded-br-md'
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
          placeholder="Reply to customer…"
          className="flex-1 rounded-full text-sm h-9"
        />
        <Button size="icon" className="h-9 w-9 rounded-full shrink-0 bg-emerald-600 hover:bg-emerald-700" onClick={sendMessage} disabled={!draft.trim() || sending}>
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  );
};

export default AdminChatPanel;
