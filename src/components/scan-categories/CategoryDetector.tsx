import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { Loader2, Wand2, CheckCircle2, AlertTriangle, HelpCircle } from "lucide-react";
import { toast } from "sonner";

export interface DetectedCategory {
  name: string;
  path: string | null;
  url: string | null;
  confidence: "high" | "medium" | "low";
  source: "breadcrumb" | "json_ld" | "url_path" | "ai" | "manual";
  supplier_domain: string;
  reason?: string;
  listing_verified?: boolean;
  verification_status?: "verified_from_listing" | "detected_but_not_verified_from_listing";
  verification?: {
    listing_verified: boolean;
    reason: string;
    category_url_checked: string | null;
    product_id_checked: string | null;
    product_link_count?: number;
    matched_via?: string;
  };
}

interface Props {
  onDetected: (result: DetectedCategory) => void;
  /** Optional pre-fill for the URL input */
  defaultUrl?: string;
  /** Compact label / button text */
  label?: string;
  /** Hide the apply button (caller wants to consume detection programmatically) */
  autoApply?: boolean;
}

const confIcon = (c: DetectedCategory["confidence"]) => {
  if (c === "high") return <CheckCircle2 className="h-3.5 w-3.5 text-primary" />;
  if (c === "medium") return <AlertTriangle className="h-3.5 w-3.5 text-muted-foreground" />;
  return <HelpCircle className="h-3.5 w-3.5 text-muted-foreground" />;
};

export function CategoryDetector({ onDetected, defaultUrl = "", label = "Auto-detect category", autoApply = false }: Props) {
  const [url, setUrl] = useState(defaultUrl);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<DetectedCategory | null>(null);

  const detect = async () => {
    const trimmed = url.trim();
    if (!trimmed) {
      toast.error("Paste a supplier product URL first");
      return;
    }
    setLoading(true);
    setResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("detect-supplier-category", {
        body: { product_url: trimmed },
      });
      if (error) throw error;
      if (!data?.ok || !data?.detection) {
        toast.error(data?.error || "Could not detect category");
        return;
      }
      const detection: DetectedCategory = {
        ...data.detection,
        supplier_domain: data.supplier_domain,
      };
      setResult(detection);
      if (autoApply) {
        onDetected(detection);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Detection failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-2 rounded-md border border-dashed border-primary/40 bg-primary/5 p-3">
      <Label className="text-xs font-semibold flex items-center gap-1.5">
        <Wand2 className="h-3.5 w-3.5 text-primary" />
        {label}
      </Label>
      <div className="flex gap-2">
        <Input
          placeholder="https://www.target.com/p/..."
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); detect(); } }}
          className="h-8 text-xs"
        />
        <Button size="sm" className="h-8 shrink-0" onClick={detect} disabled={loading}>
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Detect"}
        </Button>
      </div>

      {result && (
        <div className="rounded bg-background p-2 text-xs space-y-1.5">
          <div className="flex items-center gap-2 flex-wrap">
            {confIcon(result.confidence)}
            <span className="font-medium">{result.name}</span>
            <Badge variant="outline" className="text-[10px] capitalize">{result.source.replace("_", " ")}</Badge>
            <Badge variant={result.confidence === "high" ? "default" : "secondary"} className="text-[10px] capitalize">
              {result.confidence}
            </Badge>
            {result.listing_verified ? (
              <Badge variant="default" className="text-[10px] gap-1">
                <CheckCircle2 className="h-3 w-3" />
                Verified on listing
              </Badge>
            ) : result.verification_status === "detected_but_not_verified_from_listing" ? (
              <Badge variant="secondary" className="text-[10px] gap-1 border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300">
                <AlertTriangle className="h-3 w-3" />
                Not verified from listing
              </Badge>
            ) : null}
          </div>
          {result.path && result.path !== result.name && (
            <div className="text-muted-foreground truncate">{result.path}</div>
          )}
          {result.url && (
            <div className="text-muted-foreground truncate">
              URL: <span className="font-mono">{result.url}</span>
            </div>
          )}
          {result.verification && !result.listing_verified && (
            <div className="text-[10px] text-amber-700 dark:text-amber-400">
              Reason: {result.verification.reason.replace(/_/g, " ")}
              {typeof result.verification.product_link_count === "number" && (
                <> · {result.verification.product_link_count} product links seen on category page</>
              )}
            </div>
          )}
          {!autoApply && (
            <Button size="sm" variant="secondary" className="h-7 text-xs" onClick={() => onDetected(result)}>
              Use this category
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
