import { useState, useEffect, useCallback, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Loader2, Trash2, Sparkles, Upload } from "lucide-react";
import {
  Supplier, SupplierType, SupplierTrustLevel, SupplierOrigin,
  toneClass, normalizeDomain,
} from "./shared";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged?: () => void; // notify parent to reload suppliers
}

const ORIGIN_TONE = (o: SupplierOrigin) =>
  o === "curated" ? toneClass("good")
  : o === "tactical_arbitrage" ? toneClass("ai")
  : toneClass("ok");

const TRUST_TONE = (t: SupplierTrustLevel) =>
  t === "verified" ? toneClass("good")
  : t === "trusted" ? toneClass("ok")
  : toneClass("ai");

export default function SupplierRegistryDialog({ open, onOpenChange, onChanged }: Props) {
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [search, setSearch] = useState("");
  const [originFilter, setOriginFilter] = useState<"all" | SupplierOrigin>("all");
  const [trustFilter, setTrustFilter] = useState<"all" | SupplierTrustLevel>("all");
  const [typeFilter, setTypeFilter] = useState<"all" | SupplierType>("all");

  // Import form state
  const [pasteText, setPasteText] = useState("");
  const [importOrigin, setImportOrigin] = useState<SupplierOrigin>("curated");
  const [importTrust, setImportTrust] = useState<SupplierTrustLevel>("trusted");
  const [importType, setImportType] = useState<SupplierType>("retail");
  const [importing, setImporting] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const { data, error } = await supabase
      .from("suppliers")
      .select("*")
      .eq("user_id", user.id)
      .order("source_origin", { ascending: true })
      .order("domain", { ascending: true });
    if (error) toast.error(error.message);
    setSuppliers((data as Supplier[]) || []);
    setLoading(false);
  }, [user]);

  useEffect(() => { if (open) load(); }, [open, load]);

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    return suppliers.filter((sup) => {
      if (originFilter !== "all" && sup.source_origin !== originFilter) return false;
      if (trustFilter !== "all" && sup.trust_level !== trustFilter) return false;
      if (typeFilter !== "all" && sup.supplier_type !== typeFilter) return false;
      if (!s) return true;
      return (
        sup.domain.toLowerCase().includes(s) ||
        (sup.supplier_name || "").toLowerCase().includes(s)
      );
    });
  }, [suppliers, search, originFilter, trustFilter, typeFilter]);

  const counts = useMemo(() => ({
    total: suppliers.length,
    curated: suppliers.filter((s) => s.source_origin === "curated").length,
    ta: suppliers.filter((s) => s.source_origin === "tactical_arbitrage").length,
    user: suppliers.filter((s) => s.source_origin === "user_added").length,
  }), [suppliers]);

  // Import QA summary — shown after a successful import
  const [lastImport, setLastImport] = useState<{
    pasted: number;
    valid: number;
    invalid: number;
    duplicatesInPaste: number;
    alreadyInRegistry: number;
    inserted: number;
  } | null>(null);

  const handleImport = async () => {
    if (!user) return;
    const rawLines = pasteText
      .split(/[\n,;]+/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const pasted = rawLines.length;

    const normalizedAll = rawLines.map((l) => normalizeDomain(l));
    const validList = normalizedAll.filter((l) => l.length > 0 && l.includes("."));
    const invalid = pasted - validList.length;

    const unique = Array.from(new Set(validList));
    const duplicatesInPaste = validList.length - unique.length;

    if (unique.length === 0) {
      toast.error("Paste at least one valid domain");
      setLastImport({ pasted, valid: 0, invalid, duplicatesInPaste: 0, alreadyInRegistry: 0, inserted: 0 });
      return;
    }

    setImporting(true);
    try {
      // Detect which are already in the registry (so the QA summary is honest about "new vs upserted")
      const { data: existing } = await supabase
        .from("suppliers")
        .select("domain")
        .eq("user_id", user.id)
        .in("domain", unique);
      const existingSet = new Set((existing || []).map((r) => r.domain));
      const alreadyInRegistry = existingSet.size;
      const inserted = unique.length - alreadyInRegistry;

      const rows = unique.map((domain) => ({
        user_id: user.id,
        domain,
        supplier_type: importType,
        trust_level: importTrust,
        source_origin: importOrigin,
        supports_scraping: true,
      }));
      // Upsert by (user_id, domain) — domain is normalized server-side too.
      const { error } = await supabase
        .from("suppliers")
        .upsert(rows, { onConflict: "user_id,domain", ignoreDuplicates: false });
      if (error) throw error;

      setLastImport({
        pasted,
        valid: validList.length,
        invalid,
        duplicatesInPaste,
        alreadyInRegistry,
        inserted,
      });
      toast.success(
        `Imported ${unique.length} supplier${unique.length === 1 ? "" : "s"}` +
        (inserted !== unique.length ? ` (${inserted} new, ${alreadyInRegistry} updated)` : "")
      );
      setPasteText("");
      await load();
      onChanged?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  };

  const handleDelete = async (id: string) => {
    const { error } = await supabase.from("suppliers").delete().eq("id", id);
    if (error) { toast.error(error.message); return; }
    setSuppliers((prev) => prev.filter((s) => s.id !== id));
    onChanged?.();
  };

  const handleUpdate = async (id: string, patch: Partial<Supplier>) => {
    const { error } = await supabase.from("suppliers").update(patch).eq("id", id);
    if (error) { toast.error(error.message); return; }
    setSuppliers((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
    onChanged?.();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            Supplier Registry
          </DialogTitle>
          <DialogDescription>
            Your curated supplier network. Curated suppliers get a strong ranking boost in Supplier Discovery.
            Manage your suppliers here and toggle <span className="text-foreground font-medium">My suppliers only</span> on the search page to filter results.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="outline">Total · {counts.total}</Badge>
          <Badge variant="outline" className={toneClass("good")}>Curated · {counts.curated}</Badge>
          <Badge variant="outline" className={toneClass("ai")}>Tactical Arbitrage · {counts.ta}</Badge>
          <Badge variant="outline" className={toneClass("ok")}>User-added · {counts.user}</Badge>
        </div>

        <Tabs defaultValue="manage" className="flex-1 flex flex-col overflow-hidden">
          <TabsList className="self-start">
            <TabsTrigger value="manage">Manage</TabsTrigger>
            <TabsTrigger value="import">
              <Upload className="h-3 w-3 mr-1" /> Import
            </TabsTrigger>
          </TabsList>

          <TabsContent value="manage" className="flex-1 overflow-hidden flex flex-col gap-3 mt-2">
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
              <Input
                placeholder="Search domain or name…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="sm:col-span-1"
              />
              <Select value={originFilter} onValueChange={(v) => setOriginFilter(v as typeof originFilter)}>
                <SelectTrigger><SelectValue placeholder="Origin" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All origins</SelectItem>
                  <SelectItem value="curated">Curated</SelectItem>
                  <SelectItem value="tactical_arbitrage">Tactical Arbitrage</SelectItem>
                  <SelectItem value="user_added">User-added</SelectItem>
                </SelectContent>
              </Select>
              <Select value={trustFilter} onValueChange={(v) => setTrustFilter(v as typeof trustFilter)}>
                <SelectTrigger><SelectValue placeholder="Trust" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All trust levels</SelectItem>
                  <SelectItem value="verified">Verified</SelectItem>
                  <SelectItem value="trusted">Trusted</SelectItem>
                  <SelectItem value="unknown">Unknown</SelectItem>
                </SelectContent>
              </Select>
              <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v as typeof typeFilter)}>
                <SelectTrigger><SelectValue placeholder="Type" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All types</SelectItem>
                  <SelectItem value="retail">Retail</SelectItem>
                  <SelectItem value="wholesale">Wholesale</SelectItem>
                  <SelectItem value="distributor">Distributor</SelectItem>
                  <SelectItem value="unknown">Unknown</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex-1 overflow-auto border border-border/40 rounded-md">
              {loading ? (
                <div className="flex items-center justify-center py-12 text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin" />
                </div>
              ) : filtered.length === 0 ? (
                <div className="text-center text-sm text-muted-foreground py-12">
                  No suppliers match these filters. Use the <span className="text-foreground font-medium">Import</span> tab to add your list.
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="text-xs text-muted-foreground sticky top-0 bg-card">
                    <tr className="border-b border-border/30">
                      <th className="text-left py-2 px-3">Domain</th>
                      <th className="text-left py-2 px-3">Origin</th>
                      <th className="text-left py-2 px-3">Trust</th>
                      <th className="text-left py-2 px-3">Type</th>
                      <th className="text-right py-2 px-3"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((s) => (
                      <tr key={s.id} className="border-b border-border/20 hover:bg-muted/10">
                        <td className="py-2 px-3 font-mono text-foreground">{s.domain}</td>
                        <td className="py-2 px-3">
                          <Badge variant="outline" className={ORIGIN_TONE(s.source_origin)}>
                            {s.source_origin}
                          </Badge>
                        </td>
                        <td className="py-2 px-3">
                          <Select
                            value={s.trust_level}
                            onValueChange={(v) => handleUpdate(s.id, { trust_level: v as SupplierTrustLevel })}
                          >
                            <SelectTrigger className="h-7 w-[110px] text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="verified">verified</SelectItem>
                              <SelectItem value="trusted">trusted</SelectItem>
                              <SelectItem value="unknown">unknown</SelectItem>
                            </SelectContent>
                          </Select>
                        </td>
                        <td className="py-2 px-3">
                          <Select
                            value={s.supplier_type}
                            onValueChange={(v) => handleUpdate(s.id, { supplier_type: v as SupplierType })}
                          >
                            <SelectTrigger className="h-7 w-[120px] text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="retail">retail</SelectItem>
                              <SelectItem value="wholesale">wholesale</SelectItem>
                              <SelectItem value="distributor">distributor</SelectItem>
                              <SelectItem value="unknown">unknown</SelectItem>
                            </SelectContent>
                          </Select>
                        </td>
                        <td className="py-2 px-3 text-right">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleDelete(s.id)}
                            title="Remove supplier"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </TabsContent>

          <TabsContent value="import" className="flex-1 overflow-auto mt-2 space-y-3">
            <div className="text-xs text-muted-foreground">
              Paste one domain per line (commas and semicolons also work). Examples: <span className="font-mono">costco.com</span>, <span className="font-mono">www.target.com/c/grocery</span>.
              We strip <span className="font-mono">https://</span> and <span className="font-mono">www.</span> automatically. Existing rows are upserted (origin + trust + type are updated to the values below).
            </div>

            <Textarea
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              placeholder={"costco.com\ntarget.com\nwalmart.com\nbestbuy.com"}
              className="min-h-[180px] font-mono text-xs"
            />

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <div>
                <div className="text-xs text-muted-foreground mb-1">Origin</div>
                <Select value={importOrigin} onValueChange={(v) => {
                  const next = v as SupplierOrigin;
                  setImportOrigin(next);
                  // Sensible default trust per origin
                  if (next === "curated") setImportTrust("trusted");
                  else if (next === "tactical_arbitrage") setImportTrust("unknown");
                  else setImportTrust("unknown");
                }}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="curated">Curated (your network)</SelectItem>
                    <SelectItem value="tactical_arbitrage">Tactical Arbitrage</SelectItem>
                    <SelectItem value="user_added">User-added</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <div className="text-xs text-muted-foreground mb-1">Trust level</div>
                <Select value={importTrust} onValueChange={(v) => setImportTrust(v as SupplierTrustLevel)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="verified">Verified</SelectItem>
                    <SelectItem value="trusted">Trusted</SelectItem>
                    <SelectItem value="unknown">Unknown</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <div className="text-xs text-muted-foreground mb-1">Default type</div>
                <Select value={importType} onValueChange={(v) => setImportType(v as SupplierType)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="retail">Retail</SelectItem>
                    <SelectItem value="wholesale">Wholesale</SelectItem>
                    <SelectItem value="distributor">Distributor</SelectItem>
                    <SelectItem value="unknown">Unknown</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <Button onClick={handleImport} disabled={importing} className="w-full">
              {importing ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Importing…</>
                : <><Upload className="h-4 w-4 mr-2" /> Import suppliers</>}
            </Button>

            {lastImport && (
              <div className="mt-2 rounded-md border border-border/40 bg-muted/10 p-3 text-xs space-y-1.5">
                <div className="font-medium text-white">Last import summary</div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-muted-foreground">
                  <div>Total pasted: <span className="text-white font-mono">{lastImport.pasted}</span></div>
                  <div>Valid domains: <span className="text-emerald-300 font-mono">{lastImport.valid}</span></div>
                  <div>Invalid skipped: <span className="text-rose-300 font-mono">{lastImport.invalid}</span></div>
                  <div>Duplicates in paste: <span className="text-amber-300 font-mono">{lastImport.duplicatesInPaste}</span></div>
                  <div>Already in registry: <span className="text-sky-300 font-mono">{lastImport.alreadyInRegistry}</span></div>
                  <div>Newly added: <span className="text-emerald-300 font-mono">{lastImport.inserted}</span></div>
                </div>
                {lastImport.invalid > 0 && (
                  <div className="text-[11px] text-muted-foreground italic pt-1 border-t border-border/30">
                    Invalid lines were missing a "." (e.g. typos, blank rows, or single words). Check your list and re-paste.
                  </div>
                )}
              </div>
            )}
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
