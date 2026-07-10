import { useEffect, useMemo, useState, useCallback, lazy, Suspense } from "react";
import { Helmet } from "react-helmet-async";
import { Search, Plus, Copy, ExternalLink, Trash2, Loader2, FlaskConical, Calculator, Pencil } from "lucide-react";
import { toast } from "sonner";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

const ScannerStyleRoiDialog = lazy(() =>
  import("@/components/inventory/ScannerStyleRoiDialog").then((m) => ({ default: m.ScannerStyleRoiDialog }))
);

type Decision = "UNDECIDED" | "BUY" | "SKIP" | "MAYBE";

interface ResearchLead {
  id: string;
  user_id: string;
  asin: string;
  retail_url: string | null;
  supplier_name: string | null;
  source: string | null;
  date_found: string;
  notes: string | null;
  processed: boolean;
  cost: number | null;
  expected_sell_price: number | null;
  expected_roi: number | null;
  title: string | null;
  image_url: string | null;
  decision: Decision;
  tags: string[] | null;
}

const DECISION_COLORS: Record<Decision, string> = {
  UNDECIDED: "bg-slate-500/20 text-slate-300 border-slate-500/40",
  BUY: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40",
  SKIP: "bg-rose-500/20 text-rose-300 border-rose-500/40",
  MAYBE: "bg-amber-500/20 text-amber-300 border-amber-500/40",
};

const emptyForm = {
  asin: "",
  retail_url: "",
  supplier_name: "",
  source: "FBA Lead List",
  notes: "",
  cost: "",
  expected_sell_price: "",
  expected_roi: "",
  decision: "UNDECIDED" as Decision,
  tags: "",
};

export default function ResearchLeads() {
  const { user } = useAuth();
  const [leads, setLeads] = useState<ResearchLead[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [decisionFilter, setDecisionFilter] = useState<"ALL" | Decision>("ALL");
  const [processedFilter, setProcessedFilter] = useState<"ALL" | "PENDING" | "DONE">("ALL");
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [roiDialogOpen, setRoiDialogOpen] = useState(false);
  const [roiLead, setRoiLead] = useState<ResearchLead | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const fetchLeads = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const { data, error } = await supabase
      .from("research_leads" as any)
      .select("*")
      .order("date_found", { ascending: false })
      .limit(1000);
    setLoading(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    setLeads((data as any) || []);
  }, [user]);

  useEffect(() => {
    fetchLeads();
  }, [fetchLeads]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return leads.filter((l) => {
      if (decisionFilter !== "ALL" && l.decision !== decisionFilter) return false;
      if (processedFilter === "PENDING" && l.processed) return false;
      if (processedFilter === "DONE" && !l.processed) return false;
      if (!q) return true;
      return (
        l.asin?.toLowerCase().includes(q) ||
        (l.supplier_name || "").toLowerCase().includes(q) ||
        (l.retail_url || "").toLowerCase().includes(q) ||
        (l.notes || "").toLowerCase().includes(q)
      );
    });
  }, [leads, search, decisionFilter, processedFilter]);

  const resetForm = () => { setForm(emptyForm); setEditingId(null); };

  const openEdit = (l: ResearchLead) => {
    setEditingId(l.id);
    setForm({
      asin: l.asin || "",
      retail_url: l.retail_url || "",
      supplier_name: l.supplier_name || "",
      source: l.source || "FBA Lead List",
      notes: l.notes || "",
      cost: l.cost != null ? String(l.cost) : "",
      expected_sell_price: l.expected_sell_price != null ? String(l.expected_sell_price) : "",
      expected_roi: l.expected_roi != null ? String(l.expected_roi) : "",
      decision: l.decision,
      tags: (l.tags || []).join(", "),
    });
    setOpen(true);
  };

  const handleSave = async () => {
    if (!user) {
      toast.error("Please sign in.");
      return;
    }
    const asin = form.asin.trim().toUpperCase();
    if (!asin) {
      toast.error("ASIN is required.");
      return;
    }
    setSaving(true);
    const payload: any = {
      asin,
      retail_url: form.retail_url.trim() || null,
      supplier_name: form.supplier_name.trim() || null,
      source: form.source.trim() || "FBA Lead List",
      notes: form.notes.trim() || null,
      cost: form.cost ? Number(form.cost) : null,
      expected_sell_price: form.expected_sell_price ? Number(form.expected_sell_price) : null,
      expected_roi: form.expected_roi ? Number(form.expected_roi) : null,
      decision: form.decision,
      tags: form.tags
        ? form.tags.split(",").map((t) => t.trim()).filter(Boolean)
        : [],
    };
    let error;
    if (editingId) {
      ({ error } = await supabase.from("research_leads" as any).update(payload).eq("id", editingId));
    } else {
      payload.user_id = user.id;
      ({ error } = await supabase.from("research_leads" as any).insert(payload));
    }
    setSaving(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success(editingId ? "Lead updated" : "Lead saved");
    resetForm();
    setOpen(false);
    fetchLeads();
  };

  const toggleProcessed = async (lead: ResearchLead) => {
    const { error } = await supabase
      .from("research_leads" as any)
      .update({ processed: !lead.processed } as any)
      .eq("id", lead.id);
    if (error) return toast.error(error.message);
    setLeads((prev) => prev.map((l) => (l.id === lead.id ? { ...l, processed: !l.processed } : l)));
  };

  const updateDecision = async (lead: ResearchLead, decision: Decision) => {
    const { error } = await supabase
      .from("research_leads" as any)
      .update({ decision } as any)
      .eq("id", lead.id);
    if (error) return toast.error(error.message);
    setLeads((prev) => prev.map((l) => (l.id === lead.id ? { ...l, decision } : l)));
  };

  const deleteLead = async (lead: ResearchLead) => {
    if (!confirm(`Delete lead ${lead.asin}?`)) return;
    const { error } = await supabase.from("research_leads" as any).delete().eq("id", lead.id);
    if (error) return toast.error(error.message);
    setLeads((prev) => prev.filter((l) => l.id !== lead.id));
    toast.success("Lead deleted");
  };

  const copy = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    toast.success(`Copied ${label}`);
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#0f1c3f] text-white">
      <Helmet>
        <title>Research Leads · ArbiProSeller</title>
        <meta
          name="description"
          content="Private research database for past FBA Lead List items. Isolated from your live ArbiProSeller library."
        />
      </Helmet>
      <Navbar />
      <main className="flex-grow pt-28 pb-16">
        <div className="container mx-auto px-4 max-w-7xl">
          <header className="mb-6 flex items-start justify-between gap-4 flex-wrap">
            <div>
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-violet-500/15 border border-violet-400/30 text-violet-300 text-xs font-medium mb-3">
                <FlaskConical className="h-3.5 w-3.5" /> Research Database · Isolated from live data
              </div>
              <h1 className="text-3xl md:text-4xl font-bold">Research Leads</h1>
              <p className="text-sm text-white/60 mt-1">
                Rebuild your FBA Lead List history. Search by ASIN. Nothing here touches your live records, inventory or repricer.
              </p>
            </div>
            <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) resetForm(); }}>
              <DialogTrigger asChild>
                <Button className="bg-blue-600 hover:bg-blue-700">
                  <Plus className="h-4 w-4 mr-2" /> Add Lead
                </Button>
              </DialogTrigger>
              <DialogContent className="bg-[#0f1c3f] border-white/10 text-white max-w-lg [&_input]:bg-white [&_input]:text-[#0f1c3f] [&_input]:font-semibold [&_input]:placeholder:text-slate-400 [&_textarea]:bg-white [&_textarea]:text-[#0f1c3f] [&_textarea]:font-semibold [&_textarea]:placeholder:text-slate-400 [&_label]:text-white [&_label]:font-semibold [&_[role=combobox]]:bg-white [&_[role=combobox]]:text-[#0f1c3f] [&_[role=combobox]]:font-semibold">
                <DialogHeader>
                  <DialogTitle>{editingId ? "Edit Research Lead" : "New Research Lead"}</DialogTitle>
                </DialogHeader>
                <div className="space-y-3">
                  <div>
                    <Label>ASIN *</Label>
                    <Input
                      value={form.asin}
                      onChange={(e) => setForm({ ...form, asin: e.target.value })}
                      placeholder="B0CCSQ62KN"
                    />
                  </div>
                  <div>
                    <Label>Retail Store URL</Label>
                    <Input
                      value={form.retail_url}
                      onChange={(e) => setForm({ ...form, retail_url: e.target.value })}
                      placeholder="https://www.walmart.com/..."
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label>Supplier Name</Label>
                      <Input
                        value={form.supplier_name}
                        onChange={(e) => setForm({ ...form, supplier_name: e.target.value })}
                        placeholder="Walmart"
                      />
                    </div>
                    <div>
                      <Label>Source</Label>
                      <Input
                        value={form.source}
                        onChange={(e) => setForm({ ...form, source: e.target.value })}
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <Label>Cost</Label>
                      <Input
                        type="number"
                        step="0.01"
                        value={form.cost}
                        onChange={(e) => setForm({ ...form, cost: e.target.value })}
                      />
                    </div>
                    <div>
                      <Label>Sell Price</Label>
                      <Input
                        type="number"
                        step="0.01"
                        value={form.expected_sell_price}
                        onChange={(e) => setForm({ ...form, expected_sell_price: e.target.value })}
                      />
                    </div>
                    <div>
                      <Label>ROI %</Label>
                      <Input
                        type="number"
                        step="0.1"
                        value={form.expected_roi}
                        onChange={(e) => setForm({ ...form, expected_roi: e.target.value })}
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label>Decision</Label>
                      <Select
                        value={form.decision}
                        onValueChange={(v) => setForm({ ...form, decision: v as Decision })}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="UNDECIDED">Undecided</SelectItem>
                          <SelectItem value="BUY">Buy</SelectItem>
                          <SelectItem value="MAYBE">Maybe</SelectItem>
                          <SelectItem value="SKIP">Skip</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label>Tags (comma)</Label>
                      <Input
                        value={form.tags}
                        onChange={(e) => setForm({ ...form, tags: e.target.value })}
                        placeholder="seasonal, q4"
                      />
                    </div>
                  </div>
                  <div>
                    <Label>Notes</Label>
                    <Textarea
                      value={form.notes}
                      onChange={(e) => setForm({ ...form, notes: e.target.value })}
                      rows={3}
                    />
                  </div>
                  <div className="flex justify-end gap-2 pt-2">
                    <Button variant="ghost" onClick={() => { setOpen(false); resetForm(); }}>
                      Cancel
                    </Button>
                    <Button onClick={handleSave} disabled={saving} className="bg-blue-600 hover:bg-blue-700">
                      {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : (editingId ? "Update Lead" : "Save Lead")}
                    </Button>
                  </div>
                </div>
              </DialogContent>
            </Dialog>
          </header>

          <div className="flex flex-wrap items-center gap-3 mb-4 [&_input]:bg-white [&_input]:text-[#0f1c3f] [&_input]:font-semibold [&_input]:placeholder:text-slate-400 [&_[role=combobox]]:bg-white [&_[role=combobox]]:text-[#0f1c3f] [&_[role=combobox]]:font-semibold">
            <div className="relative flex-1 min-w-[240px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500 z-10" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search ASIN, supplier, URL, notes…"
                className="pl-9"
              />
            </div>
            <Select value={decisionFilter} onValueChange={(v) => setDecisionFilter(v as any)}>
              <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All decisions</SelectItem>
                <SelectItem value="UNDECIDED">Undecided</SelectItem>
                <SelectItem value="BUY">Buy</SelectItem>
                <SelectItem value="MAYBE">Maybe</SelectItem>
                <SelectItem value="SKIP">Skip</SelectItem>
              </SelectContent>
            </Select>
            <Select value={processedFilter} onValueChange={(v) => setProcessedFilter(v as any)}>
              <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All status</SelectItem>
                <SelectItem value="PENDING">Pending</SelectItem>
                <SelectItem value="DONE">Processed</SelectItem>
              </SelectContent>
            </Select>
            <span className="text-xs text-white/50 ml-auto">
              {filtered.length} of {leads.length} leads
            </span>
          </div>

          <div className="rounded-xl border border-white/10 bg-white/[0.03] overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="border-white/10 hover:bg-transparent">
                  <TableHead className="text-white/70">ASIN</TableHead>
                  <TableHead className="text-white/70">Retail Link</TableHead>
                  <TableHead className="text-white/70">Supplier</TableHead>
                  <TableHead className="text-white/70 text-right">Cost</TableHead>
                  <TableHead className="text-white/70 text-right">Sell</TableHead>
                  <TableHead className="text-white/70 text-right">ROI%</TableHead>
                  <TableHead className="text-white/70">Decision</TableHead>
                  <TableHead className="text-white/70 text-center">Live ROI</TableHead>
                  <TableHead className="text-white/70">Date</TableHead>
                  <TableHead className="text-white/70 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow><TableCell colSpan={10} className="text-center py-10 text-white/50">
                    <Loader2 className="h-5 w-5 animate-spin inline" />
                  </TableCell></TableRow>
                ) : filtered.length === 0 ? (
                  <TableRow><TableCell colSpan={10} className="text-center py-10 text-white/50">
                    No leads yet. Click "Add Lead" to start building your research database.
                  </TableCell></TableRow>
                ) : filtered.map((l) => (
                  <TableRow key={l.id} className="border-white/10 hover:bg-white/[0.04]">
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <a
                          href={`https://www.amazon.com/dp/${l.asin}`}
                          target="_blank"
                          rel="noreferrer"
                          className="font-mono text-sm text-blue-300 hover:underline"
                        >
                          {l.asin}
                        </a>
                        <button
                          onClick={() => copy(l.asin, l.asin)}
                          className="text-white/40 hover:text-white"
                          title="Copy ASIN"
                        >
                          <Copy className="h-3 w-3" />
                        </button>
                      </div>
                    </TableCell>
                    <TableCell>
                      {l.retail_url ? (
                        <a
                          href={l.retail_url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs text-white/70 hover:text-white inline-flex items-center gap-1 max-w-[220px] truncate"
                        >
                          <ExternalLink className="h-3 w-3 shrink-0" />
                          <span className="truncate">{l.retail_url}</span>
                        </a>
                      ) : <span className="text-white/30 text-xs">—</span>}
                    </TableCell>
                    <TableCell className="text-sm">{l.supplier_name || <span className="text-white/30">—</span>}</TableCell>
                    <TableCell className="text-right text-sm">{l.cost != null ? `$${Number(l.cost).toFixed(2)}` : "—"}</TableCell>
                    <TableCell className="text-right text-sm">{l.expected_sell_price != null ? `$${Number(l.expected_sell_price).toFixed(2)}` : "—"}</TableCell>
                    <TableCell className="text-right text-sm">{l.expected_roi != null ? `${Number(l.expected_roi).toFixed(1)}%` : "—"}</TableCell>
                    <TableCell>
                      <Select value={l.decision} onValueChange={(v) => updateDecision(l, v as Decision)}>
                        <SelectTrigger className={`h-7 w-[110px] text-xs border ${DECISION_COLORS[l.decision]}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="UNDECIDED">Undecided</SelectItem>
                          <SelectItem value="BUY">Buy</SelectItem>
                          <SelectItem value="MAYBE">Maybe</SelectItem>
                          <SelectItem value="SKIP">Skip</SelectItem>
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell className="text-center">
                      <Button
                        size="sm"
                        className="h-7 px-2 bg-blue-600 hover:bg-blue-700 text-white text-xs gap-1"
                        title="Open Live ROI calculator"
                        onClick={() => { setRoiLead(l); setRoiDialogOpen(true); }}
                      >
                        <Calculator className="h-3.5 w-3.5" />
                        ROI
                      </Button>
                    </TableCell>
                    <TableCell className="text-xs text-white/60">
                      {new Date(l.date_found).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-xs"
                          onClick={() => toggleProcessed(l)}
                        >
                          <Badge variant="outline" className={l.processed ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40" : "bg-slate-500/15 text-slate-300 border-slate-500/40"}>
                            {l.processed ? "Done" : "Pending"}
                          </Badge>
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 w-7 p-0 text-amber-300 hover:text-amber-200 hover:bg-amber-500/10"
                          title="Edit lead"
                          onClick={() => openEdit(l)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 w-7 p-0 text-rose-300 hover:text-rose-200 hover:bg-rose-500/10"
                          onClick={() => deleteLead(l)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      </main>
      <Footer />

      <Suspense fallback={null}>
        {roiLead && roiDialogOpen && (
          <ScannerStyleRoiDialog
            open={roiDialogOpen}
            onOpenChange={setRoiDialogOpen}
            asin={roiLead.asin}
            unitCost={roiLead.cost ?? undefined}
            productTitle={roiLead.title ?? undefined}
            imageUrl={roiLead.image_url ?? undefined}
            currentPrice={roiLead.expected_sell_price ?? null}
            skipKeepa
          />
        )}
      </Suspense>
    </div>
  );
}
