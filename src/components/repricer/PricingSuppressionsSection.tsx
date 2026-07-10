import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { AlertTriangle, RefreshCw, ChevronDown, ChevronRight, ShieldAlert, Save, ExternalLink } from "lucide-react";

interface SuppressedRow {
  id: string;
  sku: string;
  asin: string | null;
  marketplace: string;
  pricing_suppression_raw_code: string | null;
  pricing_suppression_raw_message: string | null;
  pricing_suppression_categories: string[] | null;
  pricing_suppression_enforcement_actions: string[] | null;
  pricing_suppression_severity: string | null;
  pricing_suppression_detected_at: string | null;
  pricing_suppression_pending_clear_at: string | null;
  min_price_override: number | null;
  max_price_override: number | null;
  my_price: number | null;
}

interface UnknownRow {
  id: string;
  sku: string;
  asin: string | null;
  marketplace: string;
  listing_issue_unknown_categories: string[] | null;
}

interface Props {
  marketplace: string; // 'US' | 'CA' | 'MX' | 'BR' | 'ALL'
  isAdmin: boolean;
}

const AMAZON_DOMAIN: Record<string, string> = {
  US: 'https://www.amazon.com',
  CA: 'https://www.amazon.ca',
  MX: 'https://www.amazon.com.mx',
  BR: 'https://www.amazon.com.br',
};

const SELLER_CENTRAL_DOMAIN: Record<string, string> = {
  US: 'https://sellercentral.amazon.com',
  CA: 'https://sellercentral.amazon.ca',
  MX: 'https://sellercentral.amazon.com.mx',
  BR: 'https://sellercentral.amazon.com.br',
};

export default function PricingSuppressionsSection({ marketplace, isAdmin }: Props) {
  const [rows, setRows] = useState<SuppressedRow[]>([]);
  const [unknown, setUnknown] = useState<UnknownRow[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [expandedUnknown, setExpandedUnknown] = useState(false);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [edits, setEdits] = useState<Record<string, { min: string; max: string; price: string }>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [reactivationStatus, setReactivationStatus] = useState<Record<string, { type: "sending" | "success" | "error"; message: string }>>({});

  const load = async () => {
    setLoading(true);
    try {
      const { data: user } = await supabase.auth.getUser();
      if (!user?.user) return;

      let q = supabase
        .from("repricer_assignments")
        .select("id, sku, asin, marketplace, pricing_suppression_raw_code, pricing_suppression_raw_message, pricing_suppression_categories, pricing_suppression_enforcement_actions, pricing_suppression_severity, pricing_suppression_detected_at, pricing_suppression_pending_clear_at, min_price_override, max_price_override, last_applied_price, intl_listing_status")
        .eq("user_id", user.user.id)
        .eq("is_pricing_suppression", true);
      if (marketplace && marketplace !== "ALL") q = q.eq("marketplace", marketplace);
      const { data } = await q.order("pricing_suppression_detected_at", { ascending: false }).limit(500);
      let rawList = (data || []) as any[];

      // ---- Ghost filter (intl) ----
      // Ghost = listing no longer exists on that marketplace. Reactivating it will
      // never succeed, so hide it from the delisted queue. `verify-intl-listings-existence`
      // marks these as NOT_FOUND / DELETED / INACTIVE / UNKNOWN.
      const GHOST_INTL = new Set(["NOT_FOUND", "DELETED", "INACTIVE", "UNKNOWN", "[]", ""]);
      rawList = rawList.filter((r) => {
        if (r.marketplace === "US") return true;
        const s = String(r.intl_listing_status || "").toUpperCase();
        return !GHOST_INTL.has(s);
      });

      // ---- Current price per (sku, marketplace) ----
      // US price → inventory. Non-US price → asin_my_price_cache (marketplace-scoped).
      // Previously we always read inventory.my_price which returned the US price
      // for CA/MX/BR rows and made reactivated intl edits look like they reverted.
      const usSkus = [...new Set(rawList.filter(r => r.marketplace === "US").map(r => r.sku).filter(Boolean))];
      const intlRows = rawList.filter(r => r.marketplace !== "US");

      const usPriceBySku: Record<string, number | null> = {};
      if (usSkus.length) {
        const { data: invRows } = await supabase
          .from("inventory")
          .select("sku, my_price, price")
          .eq("user_id", user.user.id)
          .in("sku", usSkus);
        for (const iv of invRows || []) usPriceBySku[iv.sku] = (iv as any).my_price ?? (iv as any).price ?? null;
      }

      const MP_ID: Record<string, string> = {
        CA: "A2EUQ1WTGCTBG2",
        MX: "A1AM78C64UM0Y8",
        BR: "A2Q3Y263D00KWC",
      };
      const intlPriceKey = (asin: string, mpId: string, sku: string) => `${asin}|${mpId}|${sku}`;
      const intlPriceMap: Record<string, number | null> = {};
      if (intlRows.length) {
        const asins = [...new Set(intlRows.map(r => r.asin).filter(Boolean))];
        if (asins.length) {
          const { data: cacheRows } = await supabase
            .from("asin_my_price_cache")
            .select("asin, seller_sku, marketplace_id, my_price")
            .eq("user_id", user.user.id)
            .in("asin", asins);
          for (const c of cacheRows || []) {
            intlPriceMap[intlPriceKey((c as any).asin, (c as any).marketplace_id, (c as any).seller_sku)] = (c as any).my_price ?? null;
          }
        }
      }

      const list: SuppressedRow[] = rawList.map((r) => {
        let px: number | null = null;
        if (r.marketplace === "US") {
          px = usPriceBySku[r.sku] ?? r.last_applied_price ?? null;
        } else {
          const mpId = MP_ID[r.marketplace];
          px = (mpId && r.asin ? intlPriceMap[intlPriceKey(r.asin, mpId, r.sku)] : null) ?? r.last_applied_price ?? null;
        }
        return { ...r, my_price: px };
      });
      setRows(list);
      // Seed edit buffer with current overrides + price
      const seed: Record<string, { min: string; max: string; price: string }> = {};
      for (const r of list) {
        seed[r.id] = {
          min: r.min_price_override != null ? String(r.min_price_override) : "",
          max: r.max_price_override != null ? String(r.max_price_override) : "",
          price: r.my_price != null ? String(r.my_price) : "",
        };
      }
      setEdits(seed);

      if (isAdmin) {
        let uq = supabase
          .from("repricer_assignments")
          .select("id, sku, asin, marketplace, listing_issue_unknown_categories")
          .eq("user_id", user.user.id)
          .eq("listing_issue_unknown_flagged", true);
        if (marketplace && marketplace !== "ALL") uq = uq.eq("marketplace", marketplace);
        const { data: uData } = await uq.limit(200);
        setUnknown((uData || []) as UnknownRow[]);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [marketplace, isAdmin]);

  const runNow = async () => {
    setRunning(true);
    try {
      const { data, error } = await supabase.functions.invoke("detect-pricing-suppressions", { body: {} });
      if (error) throw error;
      toast.success(`Checked ${data?.total_checked ?? 0} listings — ${data?.detected ?? 0} suppressed, ${data?.cleared ?? 0} cleared`);
      await load();
    } catch (e: any) {
      toast.error(`Detection failed: ${e?.message || e}`);
    } finally {
      setRunning(false);
    }
  };

  const saveOverrides = async (row: SuppressedRow) => {
    const buf = edits[row.id];
    if (!buf) return;
    const minStr = buf.min.trim();
    const maxStr = buf.max.trim();
    const priceStr = buf.price.trim();
    // Reactivation flow: require ALL THREE values so Amazon receives a complete,
    // consistent purchasable_offer patch (price + min + max).
    if (priceStr === "" || minStr === "" || maxStr === "") {
      toast.error("Fill Price, Min and Max before reactivating");
      return;
    }
    const minVal = Number(minStr);
    const maxVal = Number(maxStr);
    const priceVal = Number(priceStr);
    if (!Number.isFinite(minVal) || minVal <= 0) { toast.error("Min must be greater than 0"); return; }
    if (!Number.isFinite(maxVal) || maxVal <= 0) { toast.error("Max must be greater than 0"); return; }
    if (!Number.isFinite(priceVal) || priceVal <= 0) { toast.error("Price must be greater than 0"); return; }
    if (minVal > maxVal) { toast.error("Min cannot be greater than Max"); return; }
    if (priceVal < minVal) { toast.error("Price is below Min — widen Min or raise Price"); return; }
    if (priceVal > maxVal) { toast.error("Price is above Max — widen Max or lower Price"); return; }

    setSavingId(row.id);
    setReactivationStatus((prev) => ({
      ...prev,
      [row.id]: { type: "sending", message: "Sending price, min and max to Amazon…" },
    }));
    const toastId = toast.loading(`Sending ${row.marketplace} ${row.sku} to Amazon…`);
    try {
      // 1) Persist min/max override in DB (repricer authoritative source)
      const { error: dbError } = await supabase
        .from("repricer_assignments")
        .update({ min_price_override: minVal, max_price_override: maxVal })
        .eq("id", row.id);
      if (dbError) throw dbError;

      // 2) Push price + min + max to Amazon in a single patch.
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");
      const payload = {
        asin: row.asin,
        sku: row.sku,
        newPrice: priceVal,
        newMinPrice: minVal,
        newMaxPrice: maxVal,
        marketplace: row.marketplace,
        updateMinMaxOnly: false,
      };
      console.log("[PricingSuppressions] Reactivate push:", payload);
      const { data: syncData, error: syncError } = await supabase.functions.invoke("update-amazon-price", {
        body: payload,
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      console.log("[PricingSuppressions] SP-API response:", syncData, syncError);
      if (syncError) throw new Error(syncError.message || "Amazon call failed");
      if (syncData && syncData.ok === false) {
        throw new Error(syncData.error || syncData.errorMessage || "Amazon rejected the update");
      }
      if (syncData && syncData.success === false) {
        throw new Error(syncData.error || syncData.message || "Amazon rejected the update");
      }

      const subId = (syncData as any)?.submissionId;
      setReactivationStatus((prev) => ({
        ...prev,
        [row.id]: { type: "sending", message: `Amazon accepted the update${subId ? ` (${String(subId).slice(0, 8)}…)` : ""}. Verifying the live listing…` },
      }));

      await new Promise((resolve) => setTimeout(resolve, 3000));

      let verificationMessage = "Seller Central can take a few minutes to reflect it.";
      let statusType: "success" | "error" = "success";
      try {
        const { data: verifyData, error: verifyError } = await supabase.functions.invoke("verify-listing-pricing", {
          body: { asin: row.asin, sku: row.sku, marketplace: row.marketplace },
          headers: { Authorization: `Bearer ${session.access_token}` },
        });

        if (verifyError) throw verifyError;

        const pricing = (verifyData as any)?.pricing || {};
        const liveParts = [
          pricing.price != null ? `price ${pricing.price}` : null,
          pricing.min != null ? `min ${pricing.min}` : null,
          pricing.max != null ? `max ${pricing.max}` : null,
        ].filter(Boolean).join(", ");

        if ((verifyData as any)?.isPricingSuppressed) {
          const issue = (verifyData as any)?.pricingIssues?.[0];
          verificationMessage = `Amazon still reports a pricing suppression${liveParts ? ` (live: ${liveParts})` : ""}: ${issue?.message || "pricing issue remains"}`;
          statusType = "error";
        } else if ((verifyData as any)?.success) {
          verificationMessage = `Live Amazon check no longer reports a pricing suppression${liveParts ? ` (live: ${liveParts})` : ""}. Seller Central may still lag.`;
        }
      } catch (verifyErr: any) {
        verificationMessage = `Amazon accepted it, but live verification failed: ${verifyErr?.message || verifyErr}`;
      }

      const successMessage = `Amazon accepted ${row.marketplace} ${row.sku}: price ${priceVal}, min ${minVal}, max ${maxVal}${subId ? ` (submission ${String(subId).slice(0, 8)}…)` : ""}. ${verificationMessage}`;
      if (statusType === "error") {
        toast.error(successMessage, { id: toastId, duration: 14000 });
      } else {
        toast.success(successMessage, { id: toastId, duration: 10000 });
      }
      setReactivationStatus((prev) => ({
        ...prev,
        [row.id]: { type: statusType, message: successMessage },
      }));
      setRows((prev) => prev.map((r) =>
        r.id === row.id
          ? { ...r, min_price_override: minVal, max_price_override: maxVal, my_price: priceVal }
          : r
      ));
    } catch (e: any) {
      console.error("[PricingSuppressions] Save failed:", e);
      const message = `Reactivate failed: ${e?.message || e}`;
      toast.error(message, { id: toastId, duration: 12000 });
      setReactivationStatus((prev) => ({
        ...prev,
        [row.id]: { type: "error", message },
      }));
    } finally {
      setSavingId(null);
    }
  };

  const groups = useMemo(() => {
    const g: Record<string, SuppressedRow[]> = {};
    for (const r of rows) (g[r.marketplace] = g[r.marketplace] || []).push(r);
    return g;
  }, [rows]);

  const totalCount = rows.length;

  if (totalCount === 0 && unknown.length === 0 && !isAdmin) return null;

  return (
    <div className="space-y-3">
      {(totalCount > 0 || isAdmin) && (
        <div className="rounded-xl border-2 border-amber-500 bg-gradient-to-r from-amber-100 to-orange-100 shadow-lg ring-1 ring-amber-400/40">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="w-full flex items-center justify-between px-4 py-3 text-left"
          >
            <div className="flex items-center gap-2">
              {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              <AlertTriangle className="h-5 w-5 text-amber-700" />
              <span className="font-bold text-amber-950 text-sm">
                Delisted for pricing policy ({totalCount})
              </span>
              <span className="text-xs text-amber-900/80">
                Listings suppressed by Amazon for price rule violations (min/max, fair pricing)
              </span>
            </div>
            <Button
              type="button"
              size="sm"
              onClick={(e) => { e.stopPropagation(); runNow(); }}
              disabled={running}
              className="h-9 gap-1.5 bg-amber-600 hover:bg-amber-700 text-white font-semibold shadow-md border border-amber-700"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${running ? "animate-spin" : ""}`} />
              {running ? "Checking…" : "Check now"}
            </Button>
          </button>
          {expanded && (
            <div className="border-t border-amber-300/50 px-4 py-3 space-y-3">
              {loading && <div className="text-xs text-muted-foreground">Loading…</div>}
              {!loading && totalCount === 0 && (
                <div className="text-xs text-muted-foreground">No pricing-policy suppressions right now.</div>
              )}
              {Object.entries(groups).map(([mp, list]) => (
                <div key={mp} className="space-y-1.5">
                  <div className="text-xs font-semibold text-amber-900">{mp} — {list.length}</div>
                  <div className="rounded-md border border-amber-200 bg-white/70 overflow-hidden">
                    <table className="w-full text-xs">
                      <thead className="bg-amber-100/60 text-amber-900">
                        <tr>
                          <th className="text-left px-2 py-1.5">SKU</th>
                          <th className="text-left px-2 py-1.5">ASIN</th>
                          <th className="text-left px-2 py-1.5">Reason</th>
                          <th className="text-left px-2 py-1.5">Min</th>
                          <th className="text-left px-2 py-1.5">Max</th>
                          <th className="text-left px-2 py-1.5">Price</th>
                          <th className="text-left px-2 py-1.5">Status</th>
                          <th className="text-left px-2 py-1.5">Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {list.map((r) => {
                          const buf = edits[r.id] || { min: "", max: "", price: "" };
                          const status = reactivationStatus[r.id];
                          const dirty =
                            (buf.min || "") !== (r.min_price_override != null ? String(r.min_price_override) : "") ||
                            (buf.max || "") !== (r.max_price_override != null ? String(r.max_price_override) : "") ||
                            (buf.price || "") !== (r.my_price != null ? String(r.my_price) : "");
                          const domain = AMAZON_DOMAIN[r.marketplace] || 'https://www.amazon.com';
                          const scDomain = SELLER_CENTRAL_DOMAIN[r.marketplace] || 'https://sellercentral.amazon.com';
                          return (
                          <tr key={r.id} className="border-t border-amber-100 align-top">
                            <td className="px-2 py-1.5 font-mono">
                              <div>{r.sku}</div>
                              <a
                                href={`${scDomain}/skucentral?mSku=${encodeURIComponent(r.sku)}${r.asin ? `&asin=${encodeURIComponent(r.asin)}` : ''}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-0.5 text-[10px] text-blue-700 hover:text-blue-900 underline"
                              >
                                Manage <ExternalLink className="h-2.5 w-2.5" />
                              </a>
                            </td>
                            <td className="px-2 py-1.5 font-mono">
                              {r.asin ? (
                                <a
                                  href={`${domain}/dp/${r.asin}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-blue-700 hover:text-blue-900 underline"
                                >
                                  {r.asin}
                                </a>
                              ) : "—"}
                            </td>
                            <td className="px-2 py-1.5">
                              <div className="flex flex-wrap gap-1">
                                {(r.pricing_suppression_categories || []).map((c) => (
                                  <Badge key={c} variant={c === "INVALID_PRICE" ? "destructive" : "secondary"} className="text-[10px]">{c}</Badge>
                                ))}
                              </div>
                              {r.pricing_suppression_raw_message && (
                                <div className="text-[10px] text-muted-foreground mt-0.5 max-w-xs truncate" title={r.pricing_suppression_raw_message}>
                                  {r.pricing_suppression_raw_message}
                                </div>
                              )}
                            </td>
                            <td className="px-2 py-1.5">
                              <Input
                                type="number"
                                step="0.01"
                                min="0"
                                inputMode="decimal"
                                value={buf.min}
                                placeholder="—"
                                onChange={(e) => setEdits((prev) => ({ ...prev, [r.id]: { min: e.target.value, max: buf.max, price: buf.price } }))}
                                className="h-8 w-24 text-sm font-semibold text-slate-900 bg-white border-2 border-slate-400 focus:border-blue-600 focus:ring-2 focus:ring-blue-500/30 shadow-sm"
                              />
                            </td>
                            <td className="px-2 py-1.5">
                              <Input
                                type="number"
                                step="0.01"
                                min="0"
                                inputMode="decimal"
                                value={buf.max}
                                placeholder="—"
                                onChange={(e) => setEdits((prev) => ({ ...prev, [r.id]: { min: buf.min, max: e.target.value, price: buf.price } }))}
                                className="h-8 w-24 text-sm font-semibold text-slate-900 bg-white border-2 border-slate-400 focus:border-blue-600 focus:ring-2 focus:ring-blue-500/30 shadow-sm"
                              />
                            </td>
                            <td className="px-2 py-1.5">
                              <Input
                                type="number"
                                step="0.01"
                                min="0"
                                inputMode="decimal"
                                value={buf.price}
                                placeholder="—"
                                onChange={(e) => setEdits((prev) => ({ ...prev, [r.id]: { min: buf.min, max: buf.max, price: e.target.value } }))}
                                className="h-8 w-24 text-sm font-semibold text-slate-900 bg-white border-2 border-emerald-500 focus:border-emerald-700 focus:ring-2 focus:ring-emerald-500/30 shadow-sm"
                              />
                            </td>
                            <td className="px-2 py-1.5">
                              {r.pricing_suppression_pending_clear_at
                                ? <Badge variant="secondary" className="text-[10px]">Pending clear</Badge>
                                : <Badge variant="destructive" className="text-[10px]">Suppressed</Badge>}
                              <div className="text-[10px] text-muted-foreground mt-0.5">
                                {r.pricing_suppression_detected_at
                                  ? new Date(r.pricing_suppression_detected_at).toLocaleDateString()
                                  : ""}
                              </div>
                            </td>
                            <td className="px-2 py-1.5">
                              <Button
                                size="sm"
                                onClick={() => saveOverrides(r)}
                                disabled={savingId === r.id || !buf.price || !buf.min || !buf.max}
                                className="h-7 gap-1 bg-blue-600 hover:bg-blue-700 text-white text-xs"
                              >
                                <Save className="h-3 w-3" />
                                {savingId === r.id ? "Sending…" : "Reactivate"}
                              </Button>
                              {status && (
                                <div
                                  className={`mt-1 max-w-[220px] text-[10px] leading-snug ${
                                    status.type === "success"
                                      ? "text-emerald-700"
                                      : status.type === "error"
                                        ? "text-red-700"
                                        : "text-blue-700"
                                  }`}
                                >
                                  {status.message}
                                </div>
                              )}
                            </td>
                          </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
              <div className="text-[11px] text-amber-900/70">
                Raw Amazon issue codes and messages are stored verbatim. Detection = <code>categories</code> includes <code>INVALID_PRICE</code> AND <code>severity=ERROR</code>. Clearance requires two consecutive clean nightly reads.
              </div>
            </div>
          )}
        </div>
      )}

      {isAdmin && unknown.length > 0 && (
        <div className="rounded-xl border border-blue-300/60 bg-blue-50/60 backdrop-blur-sm">
          <button
            onClick={() => setExpandedUnknown((v) => !v)}
            className="w-full flex items-center justify-between px-4 py-3 text-left"
          >
            <div className="flex items-center gap-2">
              {expandedUnknown ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              <ShieldAlert className="h-4 w-4 text-blue-700" />
              <span className="font-semibold text-blue-900">
                Admin: unknown suppression categories ({unknown.length})
              </span>
              <span className="text-xs text-blue-800/70">
                LISTING_SUPPRESSED + severity=ERROR from Amazon that isn't yet in our mapping — review to extend classifier
              </span>
            </div>
          </button>
          {expandedUnknown && (
            <div className="border-t border-blue-300/50 px-4 py-3">
              <div className="rounded-md border border-blue-200 bg-white/70 overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-blue-100/60 text-blue-900">
                    <tr>
                      <th className="text-left px-2 py-1.5">Marketplace</th>
                      <th className="text-left px-2 py-1.5">SKU</th>
                      <th className="text-left px-2 py-1.5">ASIN</th>
                      <th className="text-left px-2 py-1.5">Unknown categories</th>
                    </tr>
                  </thead>
                  <tbody>
                    {unknown.map((u) => (
                      <tr key={u.id} className="border-t border-blue-100">
                        <td className="px-2 py-1.5">{u.marketplace}</td>
                        <td className="px-2 py-1.5 font-mono">{u.sku}</td>
                        <td className="px-2 py-1.5 font-mono">{u.asin || "—"}</td>
                        <td className="px-2 py-1.5">
                          <div className="flex flex-wrap gap-1">
                            {(u.listing_issue_unknown_categories || []).map((c) => (
                              <Badge key={c} variant="outline" className="text-[10px]">{c}</Badge>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
