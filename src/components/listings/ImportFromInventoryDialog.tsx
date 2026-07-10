import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Search, RefreshCw, Download, Cloud } from "lucide-react";
import { toast } from "sonner";

interface InvRecord {
  asin: string;
  sku: string;
  title: string;
  image_url: string | null;
  available: number | null;
  reserved: number | null;
  inbound: number | null;
  my_price: number | null;
  price: number | null;
}

interface KeepaLookup {
  title: string | null;
  image_url: string | null;
}

interface Props {
  existingAsins: string[];
  onImported: () => void;
}

export function ImportFromInventoryDialog({ existingAsins, onImported }: Props) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [asin, setAsin] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [results, setResults] = useState<InvRecord[]>([]);
  const [searched, setSearched] = useState(false);
  const [units, setUnits] = useState("");
  const [totalCost, setTotalCost] = useState("");
  const [manualMode, setManualMode] = useState(false);
  const [manualAsin, setManualAsin] = useState("");
  const [manualTitle, setManualTitle] = useState("");
  const [manualImage, setManualImage] = useState<string | null>(null);
  const [manualSku, setManualSku] = useState("");

  const unitCost = units && totalCost && parseInt(units) > 0
    ? (parseFloat(totalCost) / parseInt(units)).toFixed(2)
    : "—";

  const handleSearch = async () => {
    const trimmed = asin.trim().toUpperCase();
    if (!trimmed || !user) return;
    setLoading(true);
    setSearched(true);
    try {
      // First try user's own inventory
      const { data, error } = await supabase
        .from("inventory")
        .select("asin, sku, title, image_url, available, reserved, inbound, my_price, price")
        .eq("user_id", user.id)
        .eq("asin", trimmed);
      if (error) throw error;

      if (data && data.length > 0) {
        setResults(data);
        setManualMode(false);
        setManualImage(null);
      } else {
        // ASIN not in user's inventory — lookup title/image from other tables
        setResults([]);
        setManualMode(true);
        setManualAsin(trimmed);

        // 1) Try inventory (any user — broader search without user_id filter)
        const { data: invAny } = await supabase
          .from("inventory")
          .select("sku, title, image_url")
          .eq("asin", trimmed)
          .not("title", "is", null)
          .limit(1)
          .maybeSingle();

        if (invAny?.title) {
          setManualTitle(invAny.title);
          setManualImage(invAny.image_url || null);
          setManualSku(invAny.sku || "");
        } else {
          // 2) Try sales_orders
          const { data: sale } = await supabase
            .from("sales_orders")
            .select("title, image_url, seller_sku")
            .eq("asin", trimmed)
            .not("title", "is", null)
            .limit(1)
            .maybeSingle();

          if (sale?.title) {
            setManualTitle(sale.title);
            setManualImage(sale.image_url || null);
            setManualSku(sale.seller_sku || "");
          } else {
            // 3) Try created_listings
            const { data: listing } = await supabase
              .from("created_listings")
              .select("title, image_url, sku")
              .eq("asin", trimmed)
              .not("title", "is", null)
              .limit(1)
              .maybeSingle();

            setManualTitle(listing?.title || "");
            setManualImage(listing?.image_url || null);
            setManualSku(listing?.sku || "");
          }
        }
      }
    } catch (err: any) {
      toast.error("Lookup failed: " + err.message);
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  const handleSyncFromSellerCentral = async () => {
    const trimmed = (manualAsin || asin).trim().toUpperCase();
    if (!trimmed || !user) return;
    setSyncing(true);
    try {
      const { data, error } = await supabase.functions.invoke("import-asin-from-seller-central", {
        body: { asin: trimmed },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      if (data?.found) {
        // Switch to results view so user can fill units/cost and import
        setResults([{
          asin: data.asin,
          sku: data.sku || trimmed,
          title: data.title || trimmed,
          image_url: data.image_url || null,
          available: data.available ?? null,
          reserved: data.reserved ?? null,
          inbound: data.inbound ?? null,
          my_price: data.my_price ?? null,
          price: data.price ?? null,
        }]);
        setManualMode(false);
        toast.success(`Synced ${trimmed} from Seller Central (${data.marketplace})`);
      } else {
        // Stay in manual mode but prefill anything we got
        if (data?.title) setManualTitle(data.title);
        if (data?.image_url) setManualImage(data.image_url);
        if (data?.sku) setManualSku(data.sku);
        toast.info(data?.message || "ASIN not found in Seller Central catalog");
      }
    } catch (err: any) {
      toast.error("Seller Central sync failed: " + (err?.message || err));
    } finally {
      setSyncing(false);
    }
  };

  const handleImport = async (item: InvRecord) => {
    if (!user) return;
    const parsedUnits = parseInt(units) || 0;
    const parsedCost = parseFloat(totalCost) || 0;
    if (parsedUnits <= 0) {
      toast.error("Enter number of units");
      return;
    }
    if (parsedCost <= 0) {
      toast.error("Enter total cost");
      return;
    }

    setSaving(true);
    try {
      const alreadyExists = existingAsins.includes(item.asin);

      if (alreadyExists) {
        // Find existing and update
        const { data: existing } = await supabase
          .from("created_listings")
          .select("id, units, cost")
          .eq("user_id", user.id)
          .eq("asin", item.asin)
          .limit(1)
          .single();

        if (existing) {
          const newUnits = (existing.units || 0) + parsedUnits;
          const newCost = (existing.cost || 0) + parsedCost;
          // IMPORTANT: do NOT touch date_created on the aggregated row — it must
          // keep its original purchase date so it stays in its historical month.
          // The new batch lives in a separate snapshot row dated today (below).
          const { error } = await supabase
            .from("created_listings")
            .update({ units: newUnits, cost: newCost, amount: newCost / newUnits })
            .eq("id", existing.id);
          if (error) throw error;
          // Record purchase in history
          await supabase.from("created_listing_purchases").insert({
            listing_id: existing.id, user_id: user.id, units: parsedUnits,
            unit_cost: parsedCost / parsedUnits, total_cost: parsedCost,
            purchase_date: new Date().toISOString(), note: "Import from Inventory",
          });
          // Snapshot row dated today so the new batch is visible in this-month filter
          // without contaminating the running average on the aggregated row.
          const snapshotSKU = `${item.sku || item.asin}-${Date.now().toString(36).toUpperCase()}`;
          await supabase.from("created_listings").insert({
            user_id: user.id,
            asin: item.asin,
            sku: snapshotSKU,
            title: item.title,
            image_url: item.image_url,
            price: item.my_price || item.price,
            units: parsedUnits,
            cost: parsedCost,
            amount: parsedCost / parsedUnits,
            date_created: new Date().toISOString(),
            notes: `New purchase batch (${parsedUnits} units). Aggregated row: ${existing.id}`,
          });
          toast.success(`Updated existing listing: +${parsedUnits} units (new batch visible in today's filter)`);
        }
      } else {
        const { data: newListing, error } = await supabase
          .from("created_listings")
          .insert({
            user_id: user.id,
            asin: item.asin,
            sku: item.sku,
            title: item.title,
            image_url: item.image_url,
            price: item.my_price || item.price,
            units: parsedUnits,
            cost: parsedCost,
            amount: parsedCost / parsedUnits,
            date_created: new Date().toISOString(),
          })
          .select("id")
          .single();
        if (error) throw error;
        // Record purchase in history
        if (newListing) {
          await supabase.from("created_listing_purchases").insert({
            listing_id: newListing.id, user_id: user.id, units: parsedUnits,
            unit_cost: parsedCost / parsedUnits, total_cost: parsedCost,
            purchase_date: new Date().toISOString(), note: "Import from Inventory",
          });
        }
        toast.success("Listing imported from inventory");
      }

      onImported();
      setOpen(false);
      setAsin("");
      setUnits("");
      setTotalCost("");
      setResults([]);
      setSearched(false);
    } catch (err: any) {
      toast.error("Import failed: " + err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleManualImport = async () => {
    if (!user) return;
    const parsedUnits = parseInt(units) || 0;
    const parsedCost = parseFloat(totalCost) || 0;
    if (parsedUnits <= 0) { toast.error("Enter number of units"); return; }
    if (parsedCost <= 0) { toast.error("Enter total cost"); return; }

    setSaving(true);
    try {
      const alreadyExists = existingAsins.includes(manualAsin);
      if (alreadyExists) {
        const { data: existing } = await supabase
          .from("created_listings")
          .select("id, units, cost")
          .eq("user_id", user.id)
          .eq("asin", manualAsin)
          .limit(1)
          .single();
        if (existing) {
          const newUnits = (existing.units || 0) + parsedUnits;
          const newCost = (existing.cost || 0) + parsedCost;
          // Keep original date_created on aggregated row; create snapshot for today.
          const { error } = await supabase
            .from("created_listings")
            .update({ units: newUnits, cost: newCost, amount: newCost / newUnits })
            .eq("id", existing.id);
          if (error) throw error;
          await supabase.from("created_listing_purchases").insert({
            listing_id: existing.id, user_id: user.id, units: parsedUnits,
            unit_cost: parsedCost / parsedUnits, total_cost: parsedCost,
            purchase_date: new Date().toISOString(), note: "Manual import",
          });
          const snapshotSKU = `${manualSku || manualAsin}-${Date.now().toString(36).toUpperCase()}`;
          await supabase.from("created_listings").insert({
            user_id: user.id,
            asin: manualAsin,
            sku: snapshotSKU,
            title: manualTitle || manualAsin,
            image_url: manualImage,
            units: parsedUnits,
            cost: parsedCost,
            amount: parsedCost / parsedUnits,
            date_created: new Date().toISOString(),
            notes: `New purchase batch (${parsedUnits} units). Aggregated row: ${existing.id}`,
          });
          toast.success(`Updated existing listing: +${parsedUnits} units (new batch visible in today's filter)`);
        }
      } else {
        const { data: newListing, error } = await supabase
          .from("created_listings")
          .insert({
            user_id: user.id,
            asin: manualAsin,
            sku: manualSku || manualAsin,
            title: manualTitle || manualAsin,
            image_url: manualImage,
            units: parsedUnits,
            cost: parsedCost,
            amount: parsedCost / parsedUnits,
            date_created: new Date().toISOString(),
          })
          .select("id")
          .single();
        if (error) throw error;
        if (newListing) {
          await supabase.from("created_listing_purchases").insert({
            listing_id: newListing.id, user_id: user.id, units: parsedUnits,
            unit_cost: parsedCost / parsedUnits, total_cost: parsedCost,
            purchase_date: new Date().toISOString(), note: "Manual import",
          });
        }
        toast.success("Listing created manually");
      }
      onImported();
      setOpen(false);
      setAsin(""); setUnits(""); setTotalCost(""); setResults([]); setSearched(false); setManualMode(false); setManualTitle(""); setManualImage(null); setManualSku("");
    } catch (err: any) {
      toast.error("Import failed: " + err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <Download className="h-3.5 w-3.5" />
          Import from Inventory
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import ASIN from Amazon Inventory</DialogTitle>
        </DialogHeader>

        <div className="space-y-2 mt-2">
          <div className="flex gap-2">
            <Input
              placeholder="Enter ASIN (e.g. B01M11DBSR)"
              value={asin}
              onChange={(e) => setAsin(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              className="flex-1"
            />
            <Button onClick={handleSearch} disabled={loading || !asin.trim()} size="icon" title="Search local inventory">
              {loading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            </Button>
          </div>
          <Button
            onClick={handleSyncFromSellerCentral}
            disabled={syncing || !asin.trim()}
            size="sm"
            variant="secondary"
            className="gap-1.5 w-full"
            title="Fetch this ASIN live from Amazon Seller Central"
          >
            {syncing ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Cloud className="h-3.5 w-3.5" />}
            Sync from Seller Central
          </Button>
        </div>

        {searched && results.length === 0 && !loading && manualMode && (
          <div className="border rounded-lg p-3 space-y-3 mt-2">
            <div className="flex items-start gap-3">
              {manualImage && (
                <img src={manualImage} alt="" className="w-12 h-12 object-contain rounded" />
              )}
              <div className="flex-1 min-w-0">
                <p className="text-sm text-muted-foreground">
                  ASIN <span className="font-mono font-semibold text-foreground">{manualAsin}</span> not found in your synced inventory.
                </p>
                {manualTitle && (
                  <p className="text-sm font-medium truncate mt-0.5">{manualTitle}</p>
                )}
                <Button
                  onClick={handleSyncFromSellerCentral}
                  disabled={syncing}
                  size="sm"
                  variant="outline"
                  className="gap-1.5 mt-2 h-7 text-xs"
                >
                  {syncing ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Cloud className="h-3 w-3" />}
                  Pull live from Seller Central
                </Button>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="text-[10px] text-muted-foreground uppercase">Units</label>
                <Input type="number" min="1" placeholder="100" value={units} onChange={(e) => setUnits(e.target.value)} className="h-8 text-sm" />
              </div>
              <div>
                <label className="text-[10px] text-muted-foreground uppercase">Total Cost ($)</label>
                <Input type="number" min="0" step="0.01" placeholder="1349.10" value={totalCost} onChange={(e) => setTotalCost(e.target.value)} className="h-8 text-sm" />
              </div>
              <div>
                <label className="text-[10px] text-muted-foreground uppercase">Unit Cost</label>
                <div className="h-8 flex items-center text-sm font-medium px-2 bg-muted/50 rounded-md">
                  {unitCost !== "—" ? `$${unitCost}` : "—"}
                </div>
              </div>
            </div>
            <Button onClick={handleManualImport} disabled={saving} className="w-full" size="sm">
              {saving ? <RefreshCw className="h-3.5 w-3.5 animate-spin mr-2" /> : null}
              {existingAsins.includes(manualAsin) ? "Add Units to Existing" : "Add to Product Library"}
            </Button>
          </div>
        )}

        {results.length > 0 && (
          <div className="space-y-4 mt-2">
            {results.map((item) => (
              <div key={item.sku} className="border rounded-lg p-3 space-y-3">
                <div className="flex items-start gap-3">
                  {item.image_url && (
                    <img src={item.image_url} alt="" className="w-12 h-12 object-contain rounded" />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{item.title}</p>
                    <p className="text-xs text-muted-foreground">
                      SKU: {item.sku} · Stock: {item.available ?? 0} avail / {item.reserved ?? 0} reserved / {item.inbound ?? 0} inbound
                    </p>
                    {existingAsins.includes(item.asin) && (
                      <p className="text-xs text-orange-500 font-medium mt-1">Already in Product Library — units will be added</p>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className="text-[10px] text-muted-foreground uppercase">Units</label>
                    <Input
                      type="number"
                      min="1"
                      placeholder="100"
                      value={units}
                      onChange={(e) => setUnits(e.target.value)}
                      className="h-8 text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-muted-foreground uppercase">Total Cost ($)</label>
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="1349.10"
                      value={totalCost}
                      onChange={(e) => setTotalCost(e.target.value)}
                      className="h-8 text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-muted-foreground uppercase">Unit Cost</label>
                    <div className="h-8 flex items-center text-sm font-medium px-2 bg-muted/50 rounded-md">
                      {unitCost !== "—" ? `$${unitCost}` : "—"}
                    </div>
                  </div>
                </div>

                <Button
                  onClick={() => handleImport(item)}
                  disabled={saving}
                  className="w-full"
                  size="sm"
                >
                  {saving ? <RefreshCw className="h-3.5 w-3.5 animate-spin mr-2" /> : null}
                  {existingAsins.includes(item.asin) ? "Add Units to Existing" : "Import to Product Library"}
                </Button>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
