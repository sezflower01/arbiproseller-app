import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Mail, Search, LogOut, Paperclip, ChevronLeft, Plus, X, Star, RefreshCw, ChevronDown, ChevronRight } from "lucide-react";
import { toast } from "sonner";

interface GmailAttachment {
  filename: string;
  mimeType: string;
  attachmentId: string;
  size: number;
}
interface GmailMessage {
  id: string;
  threadId: string;
  snippet: string;
  subject: string;
  from: string;
  to: string;
  date: string;
  internalDate: string;
  html: string;
  text: string;
  attachments: GmailAttachment[];
  labelIds: string[];
  account?: string;
}
interface SavedFilter {
  id: string;
  label: string;
  query: string;
  sort_order: number;
}
interface FilterGroup {
  filter: SavedFilter;
  messages: GmailMessage[];
  loading: boolean;
  loadingMore?: boolean;
  nextPageToken?: string | null;
  error?: string;
  collapsed: boolean;
}

const ALL = "__ALL__";

export default function EmailCenter() {
  const [accounts, setAccounts] = useState<string[]>([]);
  const [activeAccount, setActiveAccount] = useState<string>(ALL); // ALL or specific email
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [searching, setSearching] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [messages, setMessages] = useState<GmailMessage[]>([]);
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);
  const [pageTokens, setPageTokens] = useState<(string | null)[]>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const [paging, setPaging] = useState(false);
  const [selected, setSelected] = useState<GmailMessage | null>(null);
  const [hasSearched, setHasSearched] = useState(false);

  const [savedFilters, setSavedFilters] = useState<SavedFilter[]>([]);
  const [groups, setGroups] = useState<Record<string, FilterGroup>>({});
  const [showAddFilter, setShowAddFilter] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newQuery, setNewQuery] = useState("");

  useEffect(() => { void loadConnections(); }, []);

  // Re-run saved filters whenever the active account changes
  useEffect(() => {
    if (accounts.length === 0) return;
    for (const f of savedFilters) void runFilter(f);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAccount]);

  async function loadConnections() {
    setLoading(true);
    const { data: userRes } = await supabase.auth.getUser();
    if (!userRes.user) { setLoading(false); return; }
    const { data } = await supabase
      .from("gmail_connections").select("email").eq("user_id", userRes.user.id).order("created_at", { ascending: true });
    const emails = (data || []).map((d) => d.email as string);
    setAccounts(emails);
    setActiveAccount(emails.length > 1 ? ALL : (emails[0] || ALL));
    setLoading(false);
    if (emails.length > 0) await loadSavedFilters();
  }

  async function loadSavedFilters() {
    const { data: userRes } = await supabase.auth.getUser();
    if (!userRes.user) return;
    const { data, error } = await supabase
      .from("gmail_saved_filters")
      .select("*")
      .eq("user_id", userRes.user.id)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });
    if (error) { console.error(error); return; }
    const filters = (data || []) as SavedFilter[];
    setSavedFilters(filters);
    const initialGroups: Record<string, FilterGroup> = {};
    for (const f of filters) initialGroups[f.id] = { filter: f, messages: [], loading: true, collapsed: false };
    setGroups(initialGroups);
    for (const f of filters) void runFilter(f);
  }

  function accountBody() {
    return activeAccount && activeAccount !== ALL ? { email: activeAccount } : {};
  }

  async function runFilter(f: SavedFilter, append = false, pageToken?: string | null) {
    setGroups((prev) => ({
      ...prev,
      [f.id]: {
        ...(prev[f.id] || { filter: f, messages: [], collapsed: false }),
        filter: f,
        loading: !append,
        loadingMore: append,
        error: undefined,
      },
    }));
    try {
      const { data, error } = await supabase.functions.invoke("gmail-search", {
        body: { keyword: f.query, maxResults: 100, pageToken: pageToken || undefined, ...accountBody() },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      setGroups((prev) => {
        const existing = prev[f.id]?.messages || [];
        const incoming: GmailMessage[] = data.messages || [];
        return {
          ...prev,
          [f.id]: {
            ...(prev[f.id] || { filter: f, collapsed: false }),
            filter: f,
            messages: append ? [...existing, ...incoming] : incoming,
            nextPageToken: data.nextPageToken || null,
            loading: false,
            loadingMore: false,
          },
        };
      });
    } catch (e) {
      setGroups((prev) => ({
        ...prev,
        [f.id]: {
          ...(prev[f.id] || { filter: f, collapsed: false }),
          filter: f,
          messages: append ? (prev[f.id]?.messages || []) : [],
          loading: false,
          loadingMore: false,
          error: (e as Error).message,
        },
      }));
    }
  }

  async function addSavedFilter() {
    const label = newLabel.trim();
    const query = newQuery.trim();
    if (!label || !query) { toast.error("Label and keyword are required"); return; }
    const { data: userRes } = await supabase.auth.getUser();
    if (!userRes.user) return;
    const { data, error } = await supabase
      .from("gmail_saved_filters")
      .insert({ user_id: userRes.user.id, label, query, sort_order: savedFilters.length })
      .select().single();
    if (error) { toast.error("Failed to save filter: " + error.message); return; }
    const f = data as SavedFilter;
    setSavedFilters((prev) => [...prev, f]);
    setGroups((prev) => ({ ...prev, [f.id]: { filter: f, messages: [], loading: true, collapsed: false } }));
    setNewLabel(""); setNewQuery(""); setShowAddFilter(false);
    toast.success(`Saved "${label}"`);
    void runFilter(f);
  }

  async function deleteSavedFilter(id: string) {
    if (!confirm("Delete this saved filter?")) return;
    const { error } = await supabase.from("gmail_saved_filters").delete().eq("id", id);
    if (error) { toast.error("Failed to delete"); return; }
    setSavedFilters((prev) => prev.filter((f) => f.id !== id));
    setGroups((prev) => { const n = { ...prev }; delete n[id]; return n; });
  }

  function toggleCollapse(id: string) {
    setGroups((prev) => ({ ...prev, [id]: { ...prev[id], collapsed: !prev[id].collapsed } }));
  }

  function runChip(f: SavedFilter) {
    setKeyword(f.query);
    void runFilter(f);
    setGroups((prev) => ({ ...prev, [f.id]: { ...(prev[f.id] || { filter: f, messages: [], loading: false }), collapsed: false } }));
  }

  async function handleConnect() {
    setConnecting(true);
    try {
      const { data: userRes } = await supabase.auth.getUser();
      if (!userRes.user) { toast.error("You must be logged in first."); setConnecting(false); return; }
      const { data, error } = await supabase.functions.invoke("gmail-oauth-start");
      if (error) throw new Error(error.message || "Edge function call failed");
      if (data?.error) throw new Error(data.error);
      if (!data?.authUrl) throw new Error("No authUrl returned");
      window.location.href = data.authUrl;
    } catch (e) {
      toast.error("Connect Gmail failed: " + (e as Error).message, { duration: 8000 });
      setConnecting(false);
    }
  }

  async function handleDisconnect(email?: string) {
    const target = email || activeAccount;
    if (!target || target === ALL) {
      if (!confirm("Disconnect ALL Gmail accounts?")) return;
      const { error } = await supabase.functions.invoke("gmail-disconnect", { body: {} });
      if (error) { toast.error("Failed to disconnect"); return; }
      setAccounts([]); setActiveAccount(ALL); setMessages([]); setSelected(null); setHasSearched(false);
      setSavedFilters([]); setGroups({});
      toast.success("All Gmail accounts disconnected");
      return;
    }
    if (!confirm(`Disconnect ${target}?`)) return;
    const { error } = await supabase.functions.invoke("gmail-disconnect", { body: { email: target } });
    if (error) { toast.error("Failed to disconnect"); return; }
    const remaining = accounts.filter((a) => a !== target);
    setAccounts(remaining);
    setActiveAccount(remaining.length > 1 ? ALL : (remaining[0] || ALL));
    if (remaining.length === 0) {
      setMessages([]); setSelected(null); setHasSearched(false); setSavedFilters([]); setGroups({});
    }
    toast.success(`Disconnected ${target}`);
  }

  async function handleSearch(e?: React.FormEvent) {
    e?.preventDefault();
    setSearching(true); setSelected(null); setHasSearched(true);
    setMessages([]); setNextPageToken(null);
    setPageTokens([null]); setPageIndex(0);
    try {
      const { data, error } = await supabase.functions.invoke("gmail-search", {
        body: { keyword: keyword.trim(), maxResults: 100, ...accountBody() },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      setMessages(data.messages || []);
      setNextPageToken(data.nextPageToken || null);
    } catch (e) {
      toast.error("Search failed: " + (e as Error).message);
      setMessages([]); setNextPageToken(null);
    } finally { setSearching(false); }
  }

  async function handleLoadMore() {
    if (!nextPageToken) return;
    setLoadingMore(true);
    try {
      const { data, error } = await supabase.functions.invoke("gmail-search", {
        body: { keyword: keyword.trim(), maxResults: 100, pageToken: nextPageToken, ...accountBody() },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      setMessages((prev) => [...prev, ...(data.messages || [])]);
      setNextPageToken(data.nextPageToken || null);
    } catch (e) {
      toast.error("Load more failed: " + (e as Error).message);
    } finally { setLoadingMore(false); }
  }

  async function fetchPage(token: string | null) {
    const { data, error } = await supabase.functions.invoke("gmail-search", {
      body: { keyword: keyword.trim(), maxResults: 100, pageToken: token || undefined, ...accountBody() },
    });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    return { messages: (data.messages || []) as GmailMessage[], nextPageToken: data.nextPageToken || null };
  }

  async function handleNextPage() {
    if (!nextPageToken) return;
    setPaging(true);
    try {
      const { messages: msgs, nextPageToken: newNext } = await fetchPage(nextPageToken);
      const newTokens = [...pageTokens.slice(0, pageIndex + 1), nextPageToken];
      setPageTokens(newTokens);
      setPageIndex(pageIndex + 1);
      setMessages(msgs);
      setNextPageToken(newNext);
      setSelected(null);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      toast.error("Next page failed: " + (e as Error).message);
    } finally { setPaging(false); }
  }

  async function handlePrevPage() {
    if (pageIndex === 0) return;
    setPaging(true);
    try {
      const prevToken = pageTokens[pageIndex - 1];
      const { messages: msgs, nextPageToken: newNext } = await fetchPage(prevToken);
      setPageIndex(pageIndex - 1);
      setMessages(msgs);
      setNextPageToken(newNext);
      setSelected(null);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      toast.error("Previous page failed: " + (e as Error).message);
    } finally { setPaging(false); }
  }

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>;
  }

  const isAll = activeAccount === ALL;

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-7xl mx-auto p-6">
        <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <Mail className="h-7 w-7 text-primary" />
            <div>
              <h1 className="text-2xl font-bold">Email Center</h1>
              <p className="text-sm text-muted-foreground">
                Search your Gmail inboxes by keyword. Saved filters auto-run when you open this page.
              </p>
            </div>
          </div>
          {accounts.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap">
              <Button size="sm" variant="outline" onClick={handleConnect} disabled={connecting}>
                {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Add Gmail
              </Button>
              <Button size="sm" variant="outline" onClick={() => handleDisconnect()}>
                <LogOut className="h-4 w-4" /> Disconnect {isAll ? "all" : activeAccount}
              </Button>
            </div>
          )}
        </div>

        {accounts.length === 0 ? (
          <Card>
            <CardHeader><CardTitle>Connect your Gmail</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                We'll request <strong>read-only</strong> access to your Gmail so you can search emails directly inside ArbiProSeller. We never send or modify emails.
              </p>
              <Button onClick={handleConnect} disabled={connecting} className="bg-[#0f1c3f] hover:bg-[#1a2a55]">
                {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
                {connecting ? "Connecting…" : "Connect Gmail"}
              </Button>
            </CardContent>
          </Card>
        ) : (
          <>
            {/* Account switcher */}
            <Card className="mb-4">
              <CardContent className="pt-6">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold mr-1">Inbox:</span>
                  {accounts.length > 1 && (
                    <button
                      onClick={() => setActiveAccount(ALL)}
                      className={`px-3 py-1 rounded-full text-sm border transition-colors ${isAll ? "bg-[#0f1c3f] text-white border-[#0f1c3f]" : "bg-background hover:bg-accent"}`}
                    >
                      All ({accounts.length})
                    </button>
                  )}
                  {accounts.map((email) => (
                    <div key={email} className={`inline-flex items-center gap-1 rounded-full border text-sm transition-colors ${activeAccount === email ? "bg-[#0f1c3f] text-white border-[#0f1c3f]" : "bg-background hover:bg-accent"}`}>
                      <button onClick={() => setActiveAccount(email)} className="pl-3 py-1">
                        {email}
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDisconnect(email); }}
                        className={`mr-1 ml-1 p-1 rounded-full ${activeAccount === email ? "hover:bg-white/10" : "hover:bg-muted"}`}
                        title={`Disconnect ${email}`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
                {isAll && accounts.length > 1 && (
                  <p className="text-xs text-muted-foreground mt-2">
                    Showing merged results from all {accounts.length} accounts (first page each, sorted newest first).
                  </p>
                )}
              </CardContent>
            </Card>

            {/* Saved filter chips */}
            <Card className="mb-4">
              <CardContent className="pt-6">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <Star className="h-4 w-4 text-primary" />
                    <span className="font-semibold text-sm">Saved Filters</span>
                    <span className="text-xs text-muted-foreground">({savedFilters.length})</span>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => setShowAddFilter((v) => !v)}>
                    <Plus className="h-4 w-4" /> Add filter
                  </Button>
                </div>

                {showAddFilter && (
                  <div className="flex flex-col sm:flex-row gap-2 mb-3 p-3 bg-muted/30 rounded">
                    <Input placeholder="Label (e.g. Keepa Alerts)" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} className="sm:max-w-[220px]" />
                    <Input placeholder='Query (e.g. "keepa.com" or from:supplier@x.com)' value={newQuery} onChange={(e) => setNewQuery(e.target.value)} className="flex-1" />
                    <Button onClick={addSavedFilter} className="bg-[#0f1c3f] hover:bg-[#1a2a55]">Save</Button>
                    <Button variant="ghost" onClick={() => { setShowAddFilter(false); setNewLabel(""); setNewQuery(""); }}>Cancel</Button>
                  </div>
                )}

                {savedFilters.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No saved filters yet. Add one — e.g. label <code>Keepa</code> with query <code>keepa.com</code> — and it will auto-run every time you open this page.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {savedFilters.map((f) => {
                      const g = groups[f.id];
                      const count = g?.messages?.length ?? 0;
                      return (
                        <div key={f.id} className="inline-flex items-center gap-1 bg-[#0f1c3f] text-white rounded-full pl-3 pr-1 py-1 text-sm">
                          <button onClick={() => runChip(f)} className="hover:underline" title={`Run: ${f.query}`}>
                            {f.label} {g?.loading ? <Loader2 className="inline h-3 w-3 animate-spin" /> : <span className="opacity-70">({count})</span>}
                          </button>
                          <button onClick={() => deleteSavedFilter(f.id)} className="ml-1 p-1 hover:bg-white/10 rounded-full" title="Delete">
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Manual search */}
            <Card className="mb-4">
              <CardContent className="pt-6">
                <form onSubmit={handleSearch} className="flex gap-2">
                  <Input
                    placeholder='Manual search (e.g. "keepa", from:supplier@x.com, subject:invoice)'
                    value={keyword} onChange={(e) => setKeyword(e.target.value)} className="flex-1"
                  />
                  <Button type="submit" disabled={searching} className="bg-[#0f1c3f] hover:bg-[#1a2a55]">
                    {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />} Search
                  </Button>
                </form>
                <p className="text-xs text-muted-foreground mt-2">
                  Tip: use Gmail operators — <code>from:</code>, <code>subject:</code>, <code>has:attachment</code>, <code>newer_than:7d</code>.
                </p>
              </CardContent>
            </Card>

            {selected ? (
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between gap-2">
                    <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>
                      <ChevronLeft className="h-4 w-4" /> Back
                    </Button>
                    {selected.attachments.length > 0 && (
                      <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
                        <Paperclip className="h-3 w-3" /> {selected.attachments.length} attachment(s)
                      </span>
                    )}
                  </div>
                  <CardTitle className="text-lg break-words">{selected.subject || "(no subject)"}</CardTitle>
                  <div className="text-xs text-muted-foreground space-y-0.5">
                    {selected.account && <div><strong>Inbox:</strong> {selected.account}</div>}
                    <div><strong>From:</strong> {selected.from}</div>
                    <div><strong>To:</strong> {selected.to}</div>
                    <div><strong>Date:</strong> {selected.date}</div>
                  </div>
                </CardHeader>
                <CardContent>
                  {selected.html ? (
                    <iframe title="email-body" sandbox="" srcDoc={selected.html} className="w-full min-h-[600px] border rounded bg-white" />
                  ) : (
                    <pre className="whitespace-pre-wrap text-sm">{selected.text || selected.snippet}</pre>
                  )}
                </CardContent>
              </Card>
            ) : (
              <>
                {hasSearched && (
                  <Card className="mb-4">
                    <CardHeader>
                      <CardTitle className="text-base">
                        {isAll ? "All inboxes" : activeAccount} — Page {pageIndex + 1} — {messages.length} result{messages.length === 1 ? "" : "s"}
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      {searching ? (
                        <div className="flex items-center justify-center py-6"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
                      ) : messages.length === 0 ? (
                        <p className="text-sm text-muted-foreground">No emails matched.</p>
                      ) : (
                        <>
                          <MessageList messages={messages} onSelect={setSelected} showAccount={isAll} />
                          {!isAll && (
                            <div className="flex flex-wrap items-center justify-between gap-2 pt-4">
                              <div className="flex items-center gap-2">
                                <Button onClick={handlePrevPage} disabled={paging || pageIndex === 0} variant="outline" size="sm">
                                  <ChevronLeft className="h-4 w-4" /> Previous
                                </Button>
                                <span className="text-xs text-muted-foreground">Page {pageIndex + 1}</span>
                                <Button onClick={handleNextPage} disabled={paging || !nextPageToken} variant="outline" size="sm">
                                  {paging ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                                  Next <ChevronRight className="h-4 w-4" />
                                </Button>
                              </div>
                              {nextPageToken && (
                                <Button onClick={handleLoadMore} disabled={loadingMore} variant="ghost" size="sm">
                                  {loadingMore ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                                  {loadingMore ? "Loading…" : "Append next 100"}
                                </Button>
                              )}
                            </div>
                          )}
                        </>
                      )}
                    </CardContent>
                  </Card>
                )}

                {savedFilters.map((f) => {
                  const g = groups[f.id];
                  if (!g) return null;
                  return (
                    <Card key={f.id} className="mb-4">
                      <CardHeader>
                        <div className="flex items-center justify-between">
                          <button onClick={() => toggleCollapse(f.id)} className="flex items-center gap-2 text-left">
                            {g.collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                            <CardTitle className="text-base">
                              {f.label} <span className="text-xs text-muted-foreground font-normal">— {g.loading ? "loading…" : `${g.messages.length} result(s)`}</span>
                            </CardTitle>
                          </button>
                          <Button size="sm" variant="ghost" onClick={() => runFilter(f)} disabled={g.loading} title="Refresh">
                            <RefreshCw className={`h-4 w-4 ${g.loading ? "animate-spin" : ""}`} />
                          </Button>
                        </div>
                        <p className="text-xs text-muted-foreground ml-6">Query: <code>{f.query}</code></p>
                      </CardHeader>
                      {!g.collapsed && (
                        <CardContent>
                          {g.loading ? (
                            <div className="flex items-center justify-center py-6"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
                          ) : g.error ? (
                            <p className="text-sm text-destructive">Error: {g.error}</p>
                          ) : g.messages.length === 0 ? (
                            <p className="text-sm text-muted-foreground">No emails matched.</p>
                          ) : (
                            <>
                              <MessageList messages={g.messages} onSelect={setSelected} showAccount={isAll} />
                              {!isAll && (
                                <div className="flex items-center justify-between pt-4">
                                  <span className="text-xs text-muted-foreground">Showing {g.messages.length}{g.nextPageToken ? "+" : ""}</span>
                                  {g.nextPageToken && (
                                    <Button onClick={() => runFilter(f, true, g.nextPageToken)} disabled={g.loadingMore} variant="outline" size="sm">
                                      {g.loadingMore ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                                      {g.loadingMore ? "Loading…" : "Load more"}
                                    </Button>
                                  )}
                                </div>
                              )}
                            </>
                          )}
                        </CardContent>
                      )}
                    </Card>
                  );
                })}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function MessageList({ messages, onSelect, showAccount }: { messages: GmailMessage[]; onSelect: (m: GmailMessage) => void; showAccount?: boolean }) {
  return (
    <ul className="divide-y">
      {messages.map((m) => (
        <li key={`${m.account || ""}:${m.id}`} onClick={() => onSelect(m)} className="py-3 px-2 cursor-pointer hover:bg-accent rounded transition-colors">
          <div className="flex items-center justify-between gap-2">
            <div className="font-medium text-sm truncate flex-1">{m.from}</div>
            <div className="text-xs text-muted-foreground shrink-0">{m.date ? new Date(m.date).toLocaleDateString() : ""}</div>
          </div>
          <div className="text-sm font-semibold truncate">{m.subject || "(no subject)"}</div>
          <div className="text-xs text-muted-foreground truncate">{m.snippet}</div>
          <div className="flex items-center gap-2 mt-1">
            {showAccount && m.account && (
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                {m.account}
              </span>
            )}
            {m.attachments.length > 0 && (
              <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
                <Paperclip className="h-3 w-3" /> {m.attachments.length}
              </span>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
