import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Wand2, CheckCircle2, AlertTriangle } from "lucide-react";
import { toast } from "sonner";

interface SeedPdpCardProps {
  currentCategoryId: string | null;
  onSeeded?: () => void;
}

interface SeedResult {
  ok: boolean;
  status?: "seeded" | "already_seeded";
  run_id?: string;
  item_id?: string;
  matched_asin?: string;
  category_id?: string;
  supplier_domain?: string;
  chunk_triggered?: boolean;
  trigger_error?: string | null;
  error?: string;
  detail?: string;
}

/**
 * Admin-only PDP-seeded fallback for Store Scan.
 *
 * When the category crawler misses a product (e.g. Target hides certain
 * Funkos from the listing pages), an admin can paste the PDP URL here to
 * inject it directly into the curated scan results.
 *
 * Behavior:
 * - Calls the `store-scan-seed-pdp` edge function.
 * - The function creates / reuses a long-lived `manual_seed` run for the
 *   chosen category and inserts the PDP as a `pending` row.
 * - The matcher (store-scan-run process_chunk) then resolves the ASIN.
 * - The product appears in the regular Store Scan results immediately
 *   after the matcher chunk completes (typically a few seconds).
 */
export default function SeedPdpCard({ currentCategoryId, onSeeded }: SeedPdpCardProps) {
  const [pdpUrl, setPdpUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<SeedResult | null>(null);

  const submit = async () => {
    const url = pdpUrl.trim();
    if (!/^https?:\/\//i.test(url)) {
      toast.error("Paste a full PDP URL starting with https://");
      return;
    }

    setSubmitting(true);
    setResult(null);
    try {
      const { data, error } = await supabase.functions.invoke<SeedResult>(
        "store-scan-seed-pdp",
        {
          body: {
            pdp_url: url,
            category_id: currentCategoryId ?? undefined,
          },
        },
      );
      if (error) throw error;
      setResult(data ?? { ok: false, error: "no_response" });

      if (data?.ok) {
        if (data.status === "already_seeded") {
          toast.success(`Already seeded — ASIN ${data.matched_asin ?? "pending"}`);
        } else {
          toast.success(
            data.chunk_triggered
              ? "Seeded — matcher running, product will appear in a few seconds."
              : "Seeded, but matcher could not be triggered. Try again or run the category scan.",
          );
        }
        // Give the chunk a moment to run, then refresh the list.
        setTimeout(() => onSeeded?.(), 4000);
      } else {
        toast.error(data?.error ?? "Seed failed");
      }
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      setResult({ ok: false, error: msg });
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card className="p-4 mb-4 border-dashed">
      <div className="flex items-start gap-2 mb-2">
        <Wand2 className="h-4 w-4 mt-0.5 text-primary" />
        <div className="flex-1">
          <Label className="text-sm font-semibold">Admin: Seed missing PDP into Store Scan</Label>
          <p className="text-xs text-muted-foreground mt-0.5">
            Use this when the category crawler missed a product (e.g. Target hides
            certain SKUs from listing pages). The PDP is injected directly into the
            currently selected category and matched to an ASIN.
            {currentCategoryId
              ? " Will seed into the selected category."
              : " Pick a category first, or the first active one for the supplier will be used."}
          </p>
        </div>
      </div>
      <div className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-end">
        <div className="flex-1">
          <Input
            placeholder="https://www.target.com/p/.../-/A-77586172"
            value={pdpUrl}
            onChange={(e) => setPdpUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !submitting && submit()}
            disabled={submitting}
          />
        </div>
        <Button onClick={submit} disabled={submitting || !pdpUrl.trim()}>
          {submitting ? (
            <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Seeding…</>
          ) : (
            <><Wand2 className="h-4 w-4 mr-1" /> Seed PDP</>
          )}
        </Button>
      </div>

      {result && (
        <div className="mt-3 text-xs flex items-start gap-2">
          {result.ok ? (
            <>
              <CheckCircle2 className="h-4 w-4 mt-0.5 text-primary" />
              <div className="text-muted-foreground">
                <div className="font-medium text-foreground">
                  {result.status === "already_seeded" ? "Already in scan" : "Seeded"}
                </div>
                {result.matched_asin && (
                  <div>Matched ASIN: <span className="font-mono">{result.matched_asin}</span></div>
                )}
                {!result.matched_asin && (
                  <div>
                    Matcher running on run <span className="font-mono">{result.run_id?.slice(0, 8)}</span>.
                    Item id <span className="font-mono">{result.item_id?.slice(0, 8)}</span>.
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              <AlertTriangle className="h-4 w-4 mt-0.5 text-destructive" />
              <div className="text-muted-foreground">
                <div className="font-medium text-foreground">Seed failed</div>
                <div>{result.error}{result.detail ? ` — ${result.detail}` : ""}</div>
              </div>
            </>
          )}
        </div>
      )}
    </Card>
  );
}
