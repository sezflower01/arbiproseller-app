import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2, RefreshCw, Trash2, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { invokeEdgeFunction } from "@/lib/edgeFunctionClient";
import { getMarketplaceConfig } from "@/lib/marketplaceCurrency";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

interface ListingVerificationItem {
  asin: string;
  sku: string;
  marketplace: string;
  is_enabled: boolean;
  available: number | null;
  reserved: number | null;
  inbound: number | null;
  listing_status: string | null;
  assignment_id: string | null;
  assignment_created_at: string | null;
  rule_name: string | null;
}

interface VerificationResult {
  asin: string;
  sku: string;
  marketplace: string;
  marketplaceId: string;
  checkedAt: string;
  amazonExists: boolean;
  amazonStatus: string;
  liveMessage: string;
  issuesCount?: number;
  issues?: Array<{
    code?: string | null;
    message?: string | null;
    severity?: string | null;
  }>;
  summary: {
    asin: string | null;
    itemName: string | null;
    productType: string | null;
    conditionType: string | null;
    status: string | null;
  } | null;
}

interface ListingVerificationDialogProps {
  item: ListingVerificationItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onGhostRemoved?: () => void;
}

const LIVE_STATUSES = new Set(["ACTIVE", "BUYABLE", "DISCOVERABLE", "EXISTS_NO_STATUS"]);
const INACTIVE_STATUSES = new Set(["INACTIVE", "INCOMPLETE"]);
const MISSING_STATUSES = new Set(["NOT_FOUND", "NOT_IN_CATALOG"]);

function getStatusVariant(status: string | null | undefined): "default" | "secondary" | "destructive" | "outline" {
  const normalized = (status || "UNKNOWN").toUpperCase();
  if (LIVE_STATUSES.has(normalized)) return "default";
  if (MISSING_STATUSES.has(normalized)) return "destructive";
  if (INACTIVE_STATUSES.has(normalized)) return "secondary";
  return "outline";
}

function getStatusIcon(status: string | null | undefined) {
  const normalized = (status || "UNKNOWN").toUpperCase();
  if (LIVE_STATUSES.has(normalized)) return <CheckCircle2 className="h-4 w-4" />;
  if (MISSING_STATUSES.has(normalized)) return <XCircle className="h-4 w-4" />;
  return <AlertCircle className="h-4 w-4" />;
}

function formatStatusLabel(status: string | null | undefined) {
  return (status || "UNKNOWN").replace(/_/g, " ");
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

export default function ListingVerificationDialog({ item, open, onOpenChange, onGhostRemoved }: ListingVerificationDialogProps) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<VerificationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [accepting, setAccepting] = useState(false);

  const marketplaceConfig = useMemo(
    () => getMarketplaceConfig(item?.marketplace || "US"),
    [item?.marketplace],
  );

  const hasMismatch = useMemo(() => {
    if (!item || !result) return false;
    return (item.listing_status || "UNKNOWN").toUpperCase() !== (result.amazonStatus || "UNKNOWN").toUpperCase();
  }, [item, result]);

  const isGhost = useMemo(() => {
    if (!result) return false;
    const status = (result.amazonStatus || "").toUpperCase();
    return MISSING_STATUSES.has(status);
  }, [result]);

  const isLiveMismatch = useMemo(() => {
    if (!result || !hasMismatch) return false;
    const status = (result.amazonStatus || "").toUpperCase();
    return LIVE_STATUSES.has(status);
  }, [result, hasMismatch]);

  const verifyListing = useCallback(async () => {
    if (!item) return;

    setLoading(true);
    setError(null);

    // Run listing verification + a real per-ASIN live stock refresh in parallel.
    // rescue-inventory-asin hits the SP-API Summaries endpoint for this exact SKU
    // and writes the result through the freshness guard, so the DB row becomes
    // authoritative immediately after this call.
    const [verifyResp, liveResp] = await Promise.all([
      invokeEdgeFunction<VerificationResult>({
        functionName: "verify-amazon-listing",
        body: { asin: item.asin, sku: item.sku, marketplace: item.marketplace },
        maxRetries: 1,
        context: { asin: item.asin, sku: item.sku },
      }),
      invokeEdgeFunction<{ updated_db?: { available: number; reserved: number; inbound: number } }>({
        functionName: "rescue-inventory-asin",
        body: { asin: item.asin, sku: item.sku, marketplace: item.marketplace },
        maxRetries: 1,
        context: { asin: item.asin, sku: item.sku, op: "live-stock-refresh" },
      }).catch(() => ({ ok: false, data: null, errorMessage: "live refresh skipped" } as any)),
    ]);

    if (liveResp?.ok && liveResp.data?.updated_db) {
      const live = liveResp.data.updated_db;
      toast.success(`Live stock: avail=${live.available} · reserved=${live.reserved} · inbound=${live.inbound}`);
    }

    if (!verifyResp.ok || !verifyResp.data) {
      setResult(null);
      setError(verifyResp.errorMessage || "Unable to verify this listing right now.");
      setLoading(false);
      return;
    }

    setResult(verifyResp.data);
    setLoading(false);
    // Notify parent so it can refetch the inventory row and show updated quantities
    onGhostRemoved?.();
  }, [item, onGhostRemoved]);

  const handleRemoveGhost = useCallback(async () => {
    if (!item) return;
    setRemoving(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      // Update inventory listing_status to NOT_IN_CATALOG and zero out stock
      const { error: invErr } = await supabase
        .from("inventory")
        .update({
          listing_status: "NOT_IN_CATALOG",
          available: 0,
          reserved: 0,
          preserved_since: null,
          updated_at: new Date().toISOString(),
        })
        .eq("asin", item.asin)
        .eq("sku", item.sku)
        .eq("user_id", user.id);

      if (invErr) throw invErr;

      // Disable the repricer assignment
      if (item.assignment_id) {
        await supabase
          .from("repricer_assignments")
          .update({
            is_enabled: false,
            manual_paused: false,
            last_disabled_by: "user",
            last_disabled_reason: "Listing verification: marked NOT_IN_CATALOG",
            last_disabled_at: new Date().toISOString(),
          })
          .eq("id", item.assignment_id);
      }

      toast.success(`${item.asin} marked as NOT_IN_CATALOG — removed from active views.`);
      onGhostRemoved?.();
      onOpenChange(false);
    } catch (err: any) {
      toast.error(`Failed to remove ghost: ${err.message}`);
    } finally {
      setRemoving(false);
    }
  }, [item, onOpenChange, onGhostRemoved]);

  const handleAcceptAmazonStatus = useCallback(async () => {
    if (!item || !result) return;
    setAccepting(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      // Update inventory: accept Amazon's live status, clear preserved stock.
      // Use an existing allowed inventory source value so the row passes DB constraints.
      const { error: invErr } = await supabase
        .from("inventory")
        .update({
          listing_status: result.amazonStatus || "ACTIVE",
          available: 0,
          reserved: 0,
          inbound: 0,
          preserved_since: null,
          source: "amazon_sync",
          updated_at: new Date().toISOString(),
        })
        .eq("asin", item.asin)
        .eq("sku", item.sku)
        .eq("user_id", user.id);

      if (invErr) {
        console.error("[AcceptAmazon] inventory update error:", invErr);
        throw invErr;
      }

      // Disable repricer assignment since stock is 0
      const { error: assignErr } = await supabase
        .from("repricer_assignments")
        .update({
          is_enabled: false,
          manual_paused: false,
          last_disabled_by: "user",
          last_disabled_reason: "Listing verification: accepted Amazon status, stock cleared",
          last_disabled_at: new Date().toISOString(),
        })
        .eq("asin", item.asin)
        .eq("user_id", user.id);

      if (assignErr) {
        console.error("[AcceptAmazon] assignment disable error:", assignErr);
      }

      toast.success(`${item.asin} updated to ${result.amazonStatus} — stock cleared, assignment disabled.`);
      onGhostRemoved?.();
      onOpenChange(false);
    } catch (err: any) {
      console.error("[AcceptAmazon] error:", err);
      toast.error(`Failed to accept Amazon status: ${err.message}`);
    } finally {
      setAccepting(false);
    }
  }, [item, result, onOpenChange, onGhostRemoved]);

  useEffect(() => {
    if (open && item) {
      void verifyListing();
    }
  }, [open, item, verifyListing]);

  useEffect(() => {
    if (!open) {
      setError(null);
      setResult(null);
      setLoading(false);
    }
  }, [open]);

  const sellableQty = (item?.available ?? 0) + (item?.reserved ?? 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Verify Amazon listing</DialogTitle>
          <DialogDescription>
            Compare the database snapshot with Amazon's live listing response for this SKU and marketplace.
          </DialogDescription>
        </DialogHeader>

        {!item ? (
          <p className="text-sm text-muted-foreground">Select a listing first.</p>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/30 p-3">
              <div>
                <p className="text-sm font-medium">{item.asin}</p>
                <p className="text-xs text-muted-foreground">SKU {item.sku} · {marketplaceConfig.name}</p>
              </div>
              <Button type="button" size="sm" variant="outline" className="gap-2" onClick={() => void verifyListing()} disabled={loading}>
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Verify live
              </Button>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <section className="rounded-lg border border-border bg-card p-4">
                <h3 className="text-sm font-semibold">Database snapshot</h3>
                <dl className="mt-3 space-y-2 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-muted-foreground">Assignment</dt>
                    <dd>
                      <Badge variant={item.is_enabled ? "default" : "secondary"}>
                        {item.is_enabled ? "Enabled" : "Disabled"}
                      </Badge>
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-muted-foreground">Inventory row</dt>
                    <dd><Badge variant="outline">Present in database</Badge></dd>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-muted-foreground">Local listing status</dt>
                    <dd><Badge variant={getStatusVariant(item.listing_status)}>{formatStatusLabel(item.listing_status)}</Badge></dd>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-muted-foreground">Available</dt>
                    <dd>{item.available ?? 0}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-muted-foreground">Reserved</dt>
                    <dd>{item.reserved ?? 0}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-muted-foreground">Inbound</dt>
                    <dd>{item.inbound ?? 0}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-muted-foreground">Sellable qty</dt>
                    <dd>{sellableQty}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-muted-foreground">Rule</dt>
                    <dd className="text-right">{item.rule_name || "—"}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-muted-foreground">Assignment created</dt>
                    <dd className="text-right">{formatDateTime(item.assignment_created_at)}</dd>
                  </div>
                </dl>
              </section>

              <section className="rounded-lg border border-border bg-card p-4">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold">Live Amazon proof</h3>
                  {result ? <Badge variant="outline">{formatDateTime(result.checkedAt)}</Badge> : null}
                </div>

                {loading ? (
                  <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Checking Amazon listing status…
                  </div>
                ) : error ? (
                  <div className="mt-4 rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
                    {error}
                  </div>
                ) : result ? (
                  <div className="mt-4 space-y-3 text-sm">
                    <div className="flex items-center gap-2">
                      <Badge variant={getStatusVariant(result.amazonStatus)} className="gap-1">
                        {getStatusIcon(result.amazonStatus)}
                        {formatStatusLabel(result.amazonStatus)}
                      </Badge>
                      <Badge variant={result.amazonExists ? "outline" : "destructive"}>
                        {result.amazonExists ? "Exists on Amazon" : "Missing on Amazon"}
                      </Badge>
                    </div>

                    <p className="text-muted-foreground">{result.liveMessage}</p>

                    {result.issues && result.issues.length > 0 ? (
                      <div className="rounded-md border border-border bg-muted/40 p-3">
                        <p className="mb-2 text-xs font-medium text-foreground">
                          Amazon issues ({result.issuesCount ?? result.issues.length})
                        </p>
                        <div className="space-y-2 text-xs text-muted-foreground">
                          {result.issues.map((issue, index) => (
                            <div key={`${issue.code || "issue"}-${index}`} className="space-y-1">
                              <div className="flex items-center gap-2">
                                <Badge variant="outline">{issue.code || "Issue"}</Badge>
                                {issue.severity ? <Badge variant="secondary">{issue.severity}</Badge> : null}
                              </div>
                              <p>{issue.message || "No additional details from Amazon."}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    <dl className="space-y-2">
                      <div className="flex items-center justify-between gap-3">
                        <dt className="text-muted-foreground">Amazon title</dt>
                        <dd className="text-right">{result.summary?.itemName || "—"}</dd>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <dt className="text-muted-foreground">Amazon product type</dt>
                        <dd className="text-right">{result.summary?.productType || "—"}</dd>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <dt className="text-muted-foreground">Amazon condition</dt>
                        <dd className="text-right">{result.summary?.conditionType || "—"}</dd>
                      </div>
                    </dl>

                    {hasMismatch ? (
                      <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-muted-foreground space-y-2">
                        <p>
                          Mismatch detected: database says <strong>{formatStatusLabel(item.listing_status)}</strong>, but Amazon now says <strong>{formatStatusLabel(result.amazonStatus)}</strong>.
                        </p>
                        {isGhost && (
                          <Button
                            size="sm"
                            variant="destructive"
                            className="gap-2 w-full"
                            onClick={handleRemoveGhost}
                            disabled={removing}
                          >
                            {removing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                            Remove ghost listing
                          </Button>
                        )}
                        {isLiveMismatch && (
                          <div className="space-y-2">
                            <Separator />
                            <p className="text-xs text-muted-foreground">
                              Amazon confirms this listing is <strong>{formatStatusLabel(result.amazonStatus)}</strong>. 
                              Accept Amazon's status and clear stale preserved stock (set to 0)?
                            </p>
                            <Button
                              size="sm"
                              variant="default"
                              className="gap-2 w-full"
                              onClick={handleAcceptAmazonStatus}
                              disabled={accepting}
                            >
                              {accepting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                              Accept Amazon status &amp; clear stock
                            </Button>
                          </div>
                        )}
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <p className="mt-4 text-sm text-muted-foreground">Run the live check to confirm whether this seller listing is active, inactive, or missing on Amazon.</p>
                )}
              </section>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
