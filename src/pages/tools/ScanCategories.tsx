import { useEffect, useState } from "react";
import { Helmet } from "react-helmet-async";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter,
} from "@/components/ui/dialog";
import { Loader2, Plus, Pencil, Trash2, FolderTree, ExternalLink, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/contexts/AuthContext";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { ScanStatsBadge } from "@/components/scan-categories/ScanStatsBadge";
import { CategoryDetector, type DetectedCategory } from "@/components/scan-categories/CategoryDetector";

interface Category {
  id: string;
  name: string;
  supplier_domain: string;
  urls: string[];
  is_active: boolean;
  created_at: string;
  scan_tier: "hot" | "normal" | "slow";
}

const normalizeDomain = (raw: string) =>
  raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");

const ScanCategories = () => {
  const { user } = useAuth();
  const [list, setList] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Category | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", supplier_domain: "", urls: "", is_active: true });
  const [detection, setDetection] = useState<DetectedCategory | null>(null);
  const [saving, setSaving] = useState(false);
  const [scanningId, setScanningId] = useState<string | null>(null);
  const [statsRefreshKey, setStatsRefreshKey] = useState(0);

  const triggerScan = async (c: Category) => {
    setScanningId(c.id);
    try {
      const { data, error } = await supabase.functions.invoke("store-scan-run", {
        body: {
          supplier_domain: c.supplier_domain,
          category_urls: c.urls,
          category_id: c.id,
          max_products: 1000,
        },
      });
      if (error) throw error;
      const runId = (data as { error?: string; run_id?: string } | null)?.run_id;
      if (!runId) {
        throw new Error((data as { error?: string } | null)?.error ?? "No run_id returned");
      }

      let finalRun: {
        status: string | null;
        products_found: number | null;
        products_extracted: number | null;
        products_matched: number | null;
        error_message: string | null;
      } | null = null;

      const startedAt = Date.now();
      const POLL_INTERVAL_MS = 4000;
      const MAX_POLL_MS = 6 * 60 * 1000;

      while (Date.now() - startedAt < MAX_POLL_MS) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        const { data: runRow, error: runError } = await supabase
          .from("store_scan_runs")
          .select("status, products_found, products_extracted, products_matched, error_message")
          .eq("id", runId)
          .maybeSingle();

        if (runError) throw runError;
        finalRun = runRow;

        const status = (runRow?.status ?? "").toLowerCase();
        if (status === "done" || status === "completed" || status === "error" || status === "failed") {
          break;
        }
      }

      if (!finalRun) {
        throw new Error("Scan timed out before completion");
      }

      const finalStatus = (finalRun.status ?? "").toLowerCase();
      if (finalStatus === "error" || finalStatus === "failed") {
        throw new Error(finalRun.error_message ?? "Scan failed");
      }

      toast.success(
        `Scan complete: ${finalRun.products_matched ?? 0} matched from ${finalRun.products_extracted ?? finalRun.products_found ?? 0} products`
      );
      setStatsRefreshKey((k) => k + 1);
      load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`Scan failed: ${msg}`);
    } finally {
      setScanningId(null);
    }
  };

  const updateTier = async (c: Category, tier: Category["scan_tier"]) => {
    const { error } = await supabase
      .from("scan_categories")
      .update({ scan_tier: tier })
      .eq("id", c.id);
    if (error) toast.error(error.message);
    else { toast.success(`Tier set to ${tier}`); load(); }
  };

  const load = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("scan_categories")
      .select("*")
      .order("supplier_domain", { ascending: true })
      .order("name", { ascending: true });
    if (error) toast.error(error.message);
    else setList((data ?? []) as Category[]);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const openCreate = () => {
    setEditing(null);
    setForm({ name: "", supplier_domain: "", urls: "", is_active: true });
    setDetection(null);
    setOpen(true);
  };

  const openEdit = (c: Category) => {
    setEditing(c);
    setForm({
      name: c.name,
      supplier_domain: c.supplier_domain,
      urls: (c.urls ?? []).join("\n"),
      is_active: c.is_active,
    });
    setDetection(null);
    setOpen(true);
  };

  const handleDetected = (d: DetectedCategory) => {
    setDetection(d);
    // Use the breadcrumb path WITHOUT the leading store/root segment.
    // e.g. "Target > Toys > Action Figures & Playsets > Action Figures"
    //   →  "Toys > Action Figures & Playsets > Action Figures"
    const rawPath = (d.path && d.path.trim().length > 0) ? d.path.trim() : d.name;
    const parts = rawPath.split(">").map((s) => s.trim()).filter(Boolean);
    const domainRoot = d.supplier_domain.split(".")[0]?.toLowerCase() ?? "";
    if (parts.length > 1 && domainRoot && parts[0].toLowerCase() === domainRoot) {
      parts.shift();
    }
    const cleanedPath = parts.join(" > ");
    setForm((prev) => ({
      name: prev.name || cleanedPath,
      supplier_domain: prev.supplier_domain || d.supplier_domain,
      urls: d.url && !prev.urls.includes(d.url) ? (prev.urls ? prev.urls + "\n" + d.url : d.url) : prev.urls,
      is_active: prev.is_active,
    }));
    toast.success(`Detected: ${cleanedPath} (${d.confidence})`);
  };

  const save = async () => {
    if (!user) return;
    const name = form.name.trim();
    const supplier_domain = normalizeDomain(form.supplier_domain);
    const urls = form.urls.split(/\n+/).map((u) => u.trim()).filter(Boolean);
    if (!name || !supplier_domain || urls.length === 0) {
      toast.error("Name, supplier domain, and at least one URL are required.");
      return;
    }
    setSaving(true);

    // De-dupe duplicates within submitted URLs
    const dedupedUrls = Array.from(new Set(urls));

    // When creating, look for an existing category with same (supplier_domain, name)
    // to avoid creating duplicates — merge URLs into it instead.
    let existingMatch: Category | null = null;
    if (!editing) {
      const { data: matches } = await supabase
        .from("scan_categories")
        .select("*")
        .eq("supplier_domain", supplier_domain)
        .ilike("name", name)
        .limit(1);
      if (matches && matches.length > 0) {
        existingMatch = matches[0] as Category;
      }
    }

    const targetId = editing?.id ?? existingMatch?.id ?? null;
    const baseUrls = targetId
      ? (editing?.urls ?? existingMatch?.urls ?? [])
      : [];
    const mergedUrls = targetId
      ? Array.from(new Set([...(baseUrls ?? []), ...dedupedUrls]))
      : dedupedUrls;

    const payload: Record<string, unknown> = {
      name,
      supplier_domain,
      urls: mergedUrls,
      is_active: form.is_active,
      created_by: user.id,
    };
    if (detection) {
      payload.detected_from_url = detection.url ?? null;
      payload.detection_confidence = detection.confidence;
      payload.detection_source = detection.source;
      payload.detection_path = detection.path ?? null;
    }

    const { error } = targetId
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ? await supabase.from("scan_categories").update(payload as any).eq("id", targetId)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      : await supabase.from("scan_categories").insert(payload as any);
    setSaving(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    if (existingMatch && !editing) {
      const added = mergedUrls.length - (baseUrls?.length ?? 0);
      toast.success(
        added > 0
          ? `Merged into existing "${name}" (+${added} new URL${added === 1 ? "" : "s"})`
          : `Category "${name}" already exists — no new URLs to add`
      );
    } else {
      toast.success(editing ? "Category updated" : "Category created");
    }
    setOpen(false);
    load();
  };

  const remove = async (c: Category) => {
    if (!confirm(`Delete category "${c.name}"? Existing scan runs will keep their data.`)) return;
    const { error } = await supabase.from("scan_categories").delete().eq("id", c.id);
    if (error) toast.error(error.message);
    else { toast.success("Deleted"); load(); }
  };

  const toggleActive = async (c: Category) => {
    const { error } = await supabase
      .from("scan_categories")
      .update({ is_active: !c.is_active })
      .eq("id", c.id);
    if (error) toast.error(error.message);
    else load();
  };

  const removeUrl = async (c: Category, url: string) => {
    if (!confirm(`Remove this URL from "${c.name}"?\n\n${url}`)) return;
    const newUrls = (c.urls ?? []).filter((u) => u !== url);
    if (newUrls.length === 0) {
      toast.error("Cannot remove the last URL — delete the category instead.");
      return;
    }
    const { error } = await supabase
      .from("scan_categories")
      .update({ urls: newUrls })
      .eq("id", c.id);
    if (error) toast.error(error.message);
    else { toast.success("URL removed"); load(); }
  };

  // Group by supplier
  const grouped = list.reduce<Record<string, Category[]>>((acc, c) => {
    (acc[c.supplier_domain] ??= []).push(c);
    return acc;
  }, {});

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <Helmet>
        <title>Scan Categories — Admin</title>
        <meta name="description" content="Manage admin-curated scan categories users can browse." />
      </Helmet>
      <Navbar />
      <main className="flex-grow pt-24 pb-16">
        <div className="container mx-auto px-4 max-w-5xl">
          <div className="flex items-center justify-between mb-8">
            <div>
              <div className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-primary mb-2">
                <FolderTree className="h-4 w-4" />
                <span>Admin · Category Library</span>
              </div>
              <h1 className="text-3xl md:text-4xl font-bold mb-1">Scan Categories</h1>
              <p className="text-muted-foreground">
                Curate named categories (e.g. "Books") with supplier URLs. Users select these to browse pre-scanned matches.
              </p>
            </div>
            <Button onClick={openCreate}>
              <Plus className="h-4 w-4 mr-2" /> New Category
            </Button>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : list.length === 0 ? (
            <Card className="p-10 text-center">
              <FolderTree className="h-10 w-10 mx-auto mb-3 text-muted-foreground" />
              <p className="text-muted-foreground mb-4">
                No categories yet. Create your first one to let users browse it.
              </p>
              <Button onClick={openCreate}>
                <Plus className="h-4 w-4 mr-2" /> New Category
              </Button>
            </Card>
          ) : (
            <div className="space-y-8">
              {Object.entries(grouped).map(([domain, cats]) => (
                <div key={domain}>
                  <div className="flex items-center gap-2 mb-3">
                    <h2 className="text-lg font-semibold">{domain}</h2>
                    <Badge variant="secondary">{cats.length} categories</Badge>
                  </div>
                  <div className="grid gap-3">
                    {cats.map((c) => (
                      <Card key={c.id} className="p-4">
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1 flex-wrap">
                              <h3 className="font-semibold">{c.name}</h3>
                              {!c.is_active && <Badge variant="outline">Inactive</Badge>}
                              <Badge variant="secondary">{c.urls.length} URL{c.urls.length === 1 ? "" : "s"}</Badge>
                              <ScanStatsBadge categoryId={c.id} refreshKey={statsRefreshKey} />
                            </div>
                            <ul className="text-xs text-muted-foreground space-y-1">
                              {c.urls.map((u) => (
                                <li key={u} className="flex items-center gap-1 group">
                                  <ExternalLink className="h-3 w-3 shrink-0" />
                                  <a href={u} target="_blank" rel="noreferrer" className="truncate hover:underline flex-1 min-w-0">
                                    {u}
                                  </a>
                                  <Button
                                    size="icon"
                                    variant="ghost"
                                    className="h-5 w-5 shrink-0 opacity-60 hover:opacity-100"
                                    onClick={() => removeUrl(c, u)}
                                    title="Remove URL"
                                  >
                                    <Trash2 className="h-3 w-3 text-destructive" />
                                  </Button>
                                </li>
                              ))}
                            </ul>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <Select
                              value={c.scan_tier ?? "normal"}
                              onValueChange={(v) => updateTier(c, v as Category["scan_tier"])}
                            >
                              <SelectTrigger className="w-28 h-8 text-xs">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="hot">Hot · 24h</SelectItem>
                                <SelectItem value="normal">Normal · 3d</SelectItem>
                                <SelectItem value="slow">Slow · 7d</SelectItem>
                              </SelectContent>
                            </Select>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => triggerScan(c)}
                              disabled={scanningId === c.id}
                            >
                              {scanningId === c.id
                                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                : <RefreshCw className="h-3.5 w-3.5" />}
                              <span className="ml-1.5">Refresh</span>
                            </Button>
                            <Switch checked={c.is_active} onCheckedChange={() => toggleActive(c)} />
                            <Button size="icon" variant="ghost" onClick={() => openEdit(c)}>
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button size="icon" variant="ghost" onClick={() => remove(c)}>
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </div>
                        </div>
                      </Card>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent className="max-w-lg">
              <DialogHeader>
                <DialogTitle>{editing ? "Edit category" : "New category"}</DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <CategoryDetector onDetected={handleDetected} label="Auto-detect from a product URL" />

                <div>
                  <Label htmlFor="cat-name">Category name</Label>
                  <Input
                    id="cat-name"
                    placeholder="e.g. Books"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                  />
                </div>
                <div>
                  <Label htmlFor="cat-supplier">Supplier domain</Label>
                  <Input
                    id="cat-supplier"
                    placeholder="target.com"
                    value={form.supplier_domain}
                    onChange={(e) => setForm({ ...form, supplier_domain: e.target.value })}
                  />
                </div>
                <div>
                  <Label htmlFor="cat-urls">Category URLs (one per line)</Label>
                  <Textarea
                    id="cat-urls"
                    rows={5}
                    placeholder={"https://www.target.com/c/books/-/N-5xt0g\nhttps://www.target.com/c/kids-books/-/N-..."}
                    value={form.urls}
                    onChange={(e) => setForm({ ...form, urls: e.target.value })}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    id="cat-active"
                    checked={form.is_active}
                    onCheckedChange={(v) => setForm({ ...form, is_active: v })}
                  />
                  <Label htmlFor="cat-active">Active (visible to users)</Label>
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                <Button onClick={save} disabled={saving}>
                  {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  {editing ? "Save changes" : "Create category"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </main>
      <Footer />
    </div>
  );
};

export default ScanCategories;
