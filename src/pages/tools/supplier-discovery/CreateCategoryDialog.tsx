import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { Loader2, FolderPlus, Play } from "lucide-react";
import { CategoryDetector, type DetectedCategory } from "@/components/scan-categories/CategoryDetector";

interface CreateCategoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Prefill values from the supplier we just added/edited */
  supplierDomain: string;
  supplierDisplayName?: string;
  /** Called after a category is successfully created */
  onCreated?: (categoryId: string) => void;
}

/**
 * Quick "create first scan category" shortcut so a newly-added supplier
 * becomes visible to users in the User Store Scan immediately.
 *
 * Preferred flow: paste a supplier product URL, the detector finds the
 * category, and we auto-save + auto-run the first scan.
 */
export default function CreateCategoryDialog({
  open,
  onOpenChange,
  supplierDomain,
  supplierDisplayName,
  onCreated,
}: CreateCategoryDialogProps) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [urls, setUrls] = useState("");
  const [saving, setSaving] = useState(false);
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    if (open) {
      const supplierLabel = supplierDisplayName?.trim() || supplierDomain;
      setName(supplierLabel ? `${supplierLabel} — Featured` : "");
      setUrls("");
    }
  }, [open, supplierDomain, supplierDisplayName]);

  /**
   * Save (insert or merge) a category and immediately run the first scan.
   * Returns true on success so callers (auto-detect path) can close the dialog.
   */
  const persistAndScan = async (
    catName: string,
    urlList: string[],
  ): Promise<boolean> => {
    if (!catName) {
      toast.error("Category name is required");
      return false;
    }
    if (urlList.length === 0) {
      toast.error("Add at least one category URL");
      return false;
    }
    if (!supplierDomain) {
      toast.error("Missing supplier domain");
      return false;
    }

    setSaving(true);
    try {
      const { data: userRes } = await supabase.auth.getUser();
      const userId = userRes?.user?.id;
      if (!userId) {
        toast.error("You must be signed in");
        return false;
      }

      const dedupedUrls = Array.from(new Set(urlList));
      const { data: matches } = await supabase
        .from("scan_categories")
        .select("id, urls")
        .eq("supplier_domain", supplierDomain)
        .ilike("name", catName)
        .limit(1);

      const existing = matches?.[0];
      let categoryId: string | null = null;

      if (existing) {
        const merged = Array.from(new Set([...(existing.urls ?? []), ...dedupedUrls]));
        const { error: updErr } = await supabase
          .from("scan_categories")
          .update({ urls: merged, is_active: true })
          .eq("id", existing.id);
        if (updErr) throw updErr;
        categoryId = existing.id;
        toast.success(`Updated existing category "${catName}"`);
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const insertPayload: any = {
          name: catName,
          supplier_domain: supplierDomain,
          urls: dedupedUrls,
          is_active: true,
          created_by: userId,
        };
        const { data, error } = await supabase
          .from("scan_categories")
          .insert(insertPayload)
          .select("id")
          .single();
        if (error) throw error;
        categoryId = data?.id ?? null;
        toast.success(`Category created — ${supplierDomain} is now visible to users`);
      }

      if (!categoryId) return false;
      onCreated?.(categoryId);

      // Auto-run the first scan so the supplier has products immediately
      setSaving(false);
      setScanning(true);
      try {
        const { data: scanData, error: scanErr } = await supabase.functions.invoke(
          "category-diff-scan",
          { body: { category_id: categoryId } },
        );
        if (scanErr) throw scanErr;
        const stats = (scanData as { stats?: Record<string, number> })?.stats;
        toast.success(
          stats
            ? `First scan complete: +${stats.added} ~${stats.changed} -${stats.removed}`
            : "First scan complete",
        );
      } catch (scanE) {
        const msg = scanE instanceof Error ? scanE.message : String(scanE);
        toast.error(`Category saved, but scan failed: ${msg}`);
      } finally {
        setScanning(false);
      }

      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to create category";
      toast.error(msg);
      return false;
    } finally {
      setSaving(false);
    }
  };

  /** Manual "Create category" button path */
  const handleSave = async () => {
    const trimmedName = name.trim();
    const urlList = urls.split(/\n+/).map((u) => u.trim()).filter(Boolean);
    const ok = await persistAndScan(trimmedName, urlList);
    if (ok) onOpenChange(false);
  };

  /** Auto-detect path — runs the moment a detection comes back */
  const handleDetected = async (d: DetectedCategory) => {
    if (!d.url) {
      // Fall back to manual: prefill and let admin paste/confirm
      setName(d.name || name);
      toast.info("Detected a category but no URL — please paste the category URL.");
      return;
    }
    const detectedName = d.name?.trim() || name.trim();
    setName(detectedName);
    setUrls(d.url);
    const ok = await persistAndScan(detectedName, [d.url]);
    if (ok) onOpenChange(false);
  };

  const busy = saving || scanning;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create first scan category</DialogTitle>
          <DialogDescription>
            Make <span className="font-mono">{supplierDomain}</span> visible in
            the user-facing Store Scan by adding at least one active category.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <p className="text-xs text-muted-foreground">
            Don't want to pick a category? Paste a supplier product URL and we'll
            find it for you — we'll save it and run the first scan automatically.
          </p>

          <CategoryDetector
            onDetected={handleDetected}
            label="Auto-detect from product URL"
            autoApply
          />

          <div className="relative my-2">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t border-dashed" />
            </div>
            <div className="relative flex justify-center text-[10px] uppercase tracking-wider">
              <span className="bg-background px-2 text-muted-foreground">
                or fill manually
              </span>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="cat-supplier">Supplier</Label>
            <Input id="cat-supplier" value={supplierDomain} disabled className="font-mono" />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="cat-name">Category name</Label>
            <Input
              id="cat-name"
              placeholder="e.g. Kitchen Timers"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              disabled={busy}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="cat-urls">Category URLs (one per line)</Label>
            <Textarea
              id="cat-urls"
              placeholder={`https://${supplierDomain}/category-page\nhttps://${supplierDomain}/another-category`}
              value={urls}
              onChange={(e) => setUrls(e.target.value)}
              rows={4}
              disabled={busy}
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              Paste at least one category page URL from this supplier. You can add more
              later from the <button type="button" className="underline hover:text-foreground" onClick={() => navigate("/tools/scan-categories")}>Categories</button> page.
            </p>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Skip for now
          </Button>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => { onOpenChange(false); navigate("/tools/scan-categories"); }}
              disabled={busy}
            >
              Open Categories page
            </Button>
            <Button onClick={handleSave} disabled={busy || !name.trim() || !urls.trim()}>
              {scanning ? (
                <><Play className="h-4 w-4 mr-1 animate-pulse" /> Scanning…</>
              ) : saving ? (
                <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Creating…</>
              ) : (
                <><FolderPlus className="h-4 w-4 mr-1" /> Create & scan</>
              )}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
