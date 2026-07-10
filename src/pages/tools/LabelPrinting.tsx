import { useState, useEffect } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ThermalLabelPrintDialog } from "@/components/personalhour/ThermalLabelPrintDialog";
import { Printer, Loader2, RefreshCw, Database } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Helmet } from "react-helmet-async";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useFbaEligibility } from "@/hooks/use-fba-eligibility";
import { FbaReadinessTracker } from "@/components/fba/FbaReadinessTracker";

interface LabelData {
  asin: string;
  fnsku?: string | null;
  condition?: string | null;
  title: string;
}

interface FnskuOption {
  fnsku: string;
  condition: string | null;
  sku?: string | null;
}

const X_FNSKU_PATTERN = /^X[A-Z0-9]{9}$/;
const normalizeSku = (value: unknown) => (value ?? "").toString().trim();
const normalizeFnsku = (value: unknown) => (value ?? "").toString().trim().toUpperCase();

const LabelPrinting = () => {
  const { user } = useAuth();
  const { toast } = useToast();
  const [asin, setAsin] = useState("");
  const [fnsku, setFnsku] = useState("");
  const [condition, setCondition] = useState<string | null>(null);
  const [quantity, setQuantity] = useState("1");
  const [isFetching, setIsFetching] = useState(false);
  const [isFetchingFnsku, setIsFetchingFnsku] = useState(false);
  const [labelDialogOpen, setLabelDialogOpen] = useState(false);
  const [labelsForPrint, setLabelsForPrint] = useState<LabelData[]>([]);
  const [quantityPromptOpen, setQuantityPromptOpen] = useState(false);
  const [fetchedTitle, setFetchedTitle] = useState("");
  const [fetchedImageUrl, setFetchedImageUrl] = useState("");
  const [viewSyncedDialogOpen, setViewSyncedDialogOpen] = useState(false);
  const [syncedData, setSyncedData] = useState<Array<{asin: string, fnsku: string, condition: string | null}>>([]);
  const [isLoadingSyncedData, setIsLoadingSyncedData] = useState(false);
  const [availableFnskuOptions, setAvailableFnskuOptions] = useState<FnskuOption[]>([]);
  const [selectedOptionIndex, setSelectedOptionIndex] = useState<number | null>(null);
  const [isSyncingAsin, setIsSyncingAsin] = useState(false);
  // Tracks ASIN-as-FNSKU rows (manufacturer barcode listings). These cannot be
  // printed (Amazon will reject the shipment unless you're brand registered)
  // but the user MUST be told they exist so they don't accidentally print a
  // sibling condition's label thinking it belongs to a different listing.
  const [manufacturerBarcodeConditions, setManufacturerBarcodeConditions] = useState<string[]>([]);
  const fbaElig = useFbaEligibility({ asin: /^[A-Z0-9]{10}$/i.test(asin) ? asin : null, marketplace: "US" });

  useEffect(() => {
    const paramAsin = new URLSearchParams(window.location.search).get("asin")?.trim().toUpperCase();
    if (paramAsin && /^[A-Z0-9]{10}$/.test(paramAsin)) setAsin(paramAsin);
  }, []);

  const handleAsinChange = (value: string) => {
    setAsin(value);
    setFnsku("");
    setCondition(null);
    setFetchedTitle("");
    setFetchedImageUrl("");
    setAvailableFnskuOptions([]);
    setManufacturerBarcodeConditions([]);
    setSelectedOptionIndex(null);
  };

  const syncAsinFromAmazon = async () => {
    const trimmed = asin.trim().toUpperCase();
    if (!trimmed) {
      toast({ title: "Enter ASIN", description: "Provide an ASIN to sync.", variant: "destructive" });
      return;
    }
    if (!user) return;
    setIsSyncingAsin(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");

      // Discover SKU(s) for this ASIN — same approach as FBA Shipment Builder popup.
      const [{ data: invSkuRows }, { data: createdSkuRows }] = await Promise.all([
        supabase.from("inventory").select("sku").eq("user_id", user.id).eq("asin", trimmed),
        supabase.from("active_created_listings" as any).select("sku").eq("user_id", user.id).eq("asin", trimmed),
      ]);
      const skus = Array.from(
        new Set(
          [...(invSkuRows ?? []), ...(createdSkuRows ?? [])]
            .map((r: any) => (r?.sku ?? "").toString().trim())
            .filter((s) => s.length > 0),
        ),
      );

      if (skus.length === 0) {
        toast({
          title: "No SKU found",
          description: "No SKU is linked to this ASIN yet. Create the listing in Product Library first, then sync.",
          variant: "destructive",
        });
        return;
      }

      const results = await Promise.all(
        skus.map((sku) =>
          supabase.functions.invoke("rescue-inventory-asin", {
            body: { asin: trimmed, sku },
            headers: { Authorization: `Bearer ${session.access_token}` },
          }),
        ),
      );
      const anyOk = results.some((r) => !r.error);
      if (!anyOk) {
        const firstErr = results.find((r) => r.error)?.error?.message || "Sync failed";
        throw new Error(firstErr);
      }

      toast({ title: "Synced", description: `Live inventory pulled for ${trimmed}. Re-checking FNSKU…` });

      // Re-run FNSKU lookup now that fnsku_map / inventory should be populated.
      const found = await autoFetchFnsku(session, trimmed);
      if (found) {
        toast({ title: "FNSKU found", description: `Using ${found}` });
      } else {
        toast({
          title: "Still no FNSKU",
          description: "Amazon returned no FNSKU for this SKU. Enter the X00 code from Seller Central manually.",
          variant: "destructive",
        });
      }
    } catch (err: any) {
      toast({ title: "Sync failed", description: err?.message || "Unknown error", variant: "destructive" });
    } finally {
      setIsSyncingAsin(false);
    }
  };

  const fetchProductData = async () => {
    if (!asin) {
      toast({
        title: "Error",
        description: "Please enter an ASIN",
        variant: "destructive",
      });
      return;
    }

    try {
      setIsFetching(true);
      const normalizedAsin = asin.trim().toUpperCase();
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");

      const { data: productData, error: apiError } = await supabase.functions.invoke(
        'personalhour-product-data',
        {
          body: { asin: normalizedAsin },
          headers: { Authorization: `Bearer ${session.access_token}` }
        }
      );

      if (apiError) {
        const msg = apiError.message || "";

        if (msg.includes("NOT_FOUND")) {
          toast({
            title: "ASIN not found",
            description: "Amazon could not find this ASIN in the US marketplace. FNSKU printing is blocked until a valid X00 code is available.",
            variant: "destructive",
          });
          return;
        }

        if (msg.includes("QUOTA_EXCEEDED") || msg.includes("429")) {
          toast({
            title: "Amazon quota exceeded",
            description: "We hit the SP-API rate limit while fetching product data. FNSKU printing is blocked until a valid X00 code is available.",
            variant: "destructive",
          });
          return;
        }

        toast({
          title: "Error",
          description: "Failed to fetch product data: " + msg,
          variant: "destructive",
        });
        return;
      }

      if (!productData) {
        toast({
          title: "Error",
          description: "No product data returned from Amazon.",
          variant: "destructive",
        });
        return;
      }

      setFetchedTitle(productData.title || "Unknown Product");
      setFetchedImageUrl(productData.imageUrl || "");
      
      // Automatically fetch FNSKU if user has Amazon seller account connected
      const fetchedFnsku = await autoFetchFnsku(session, normalizedAsin);
      
      if (fetchedFnsku) {
        toast({
          title: "Success",
          description: `Product data & FNSKU retrieved! Using ${fetchedFnsku}`,
        });
      } else {
        toast({
          title: "Product data retrieved",
          description: "No printable X00 FNSKU was found. The label will not fall back to a sibling X00 or ASIN barcode.",
        });
      }
    } catch (error: any) {
      toast({
        title: "Error",
        description: "Failed to fetch product data: " + error.message,
        variant: "destructive",
      });
    } finally {
      setIsFetching(false);
    }
  };

  // Picks the user's seller authorization, preferring the US (home) marketplace
  // when multiple rows exist (one per marketplace). Avoids .maybeSingle() which
  // silently returns null for users with multi-marketplace connections.
  const getPrimarySellerAuth = async (userId: string) => {
    const { data, error } = await supabase
      .from('seller_authorizations')
      .select('seller_id, marketplace_id')
      .eq('user_id', userId);
    if (error || !data || data.length === 0) return null;
    return (
      data.find((r) => r.marketplace_id === 'ATVPDKIKX0DER') ?? data[0]
    );
  };

  // Silently run rescue-inventory-asin for every SKU linked to this ASIN,
  // then re-check FNSKU tables. Used as the automatic fallback when no FNSKU
  // is found locally so the user doesn't have to click "Sync" themselves.
  const runSilentRescueAndRecheck = async (
    session: any,
    lookupAsin: string,
    targetSkus?: string[],
  ): Promise<string | null> => {
    if (!user) return null;
    setIsSyncingAsin(true);
    try {
      let skus = (targetSkus ?? []).map(normalizeSku).filter((s) => s.length > 0);
      if (skus.length === 0) {
        const [{ data: invSkuRows }, { data: createdSkuRows }] = await Promise.all([
          supabase.from("inventory").select("sku").eq("user_id", user.id).eq("asin", lookupAsin),
          supabase.from("active_created_listings" as any).select("sku").eq("user_id", user.id).eq("asin", lookupAsin),
        ]);
        skus = Array.from(
          new Set(
            [...(invSkuRows ?? []), ...(createdSkuRows ?? [])]
              .map((r: any) => normalizeSku(r?.sku))
              .filter((s) => s.length > 0),
          ),
        );
      }
      if (skus.length === 0) return null;

      const rescueResults = await Promise.all(
        skus.map((sku) =>
          supabase.functions.invoke("rescue-inventory-asin", {
            body: { asin: lookupAsin, sku },
            headers: { Authorization: `Bearer ${session.access_token}` },
          }),
        ),
      );
      const recoveredOptions = rescueResults
        .map((result, index) => {
          const identity = (result.data as any)?.matched_summary_identity || (result.data as any)?.verification_trace?.matched_summary_identity;
          const recoveredFnsku = normalizeFnsku(identity?.fnsku);
          if (!X_FNSKU_PATTERN.test(recoveredFnsku)) return null;
          return {
            fnsku: recoveredFnsku,
            condition: identity?.condition || "NEW",
            sku: skus[index],
          } as FnskuOption;
        })
        .filter((option): option is FnskuOption => Boolean(option));

      if (recoveredOptions.length > 0) {
        setAvailableFnskuOptions(recoveredOptions);
        setSelectedOptionIndex(0);
        setFnsku(recoveredOptions[0].fnsku);
        setCondition(recoveredOptions[0].condition || "NEW");
        return recoveredOptions[0].fnsku;
      }

      // Re-check, but block recursion via allowAutoSync=false.
      return await autoFetchFnsku(session, lookupAsin, false);
    } catch (err) {
      console.warn("Silent FNSKU rescue failed:", err);
      return null;
    } finally {
      setIsSyncingAsin(false);
    }
  };

  const autoFetchFnsku = async (session: any, lookupAsin = asin.trim().toUpperCase(), allowAutoSync = true): Promise<string | null> => {
    console.log("🔍 Auto-fetching ALL FNSKUs for ASIN:", lookupAsin);
    setIsFetchingFnsku(true);
    try {
      // Get seller authorization first (home-marketplace aware)
      const sellerAuth = await getPrimarySellerAuth(session.user.id);

      if (!sellerAuth) {
        console.log("⚠️ No seller authorization found");
        setAvailableFnskuOptions([]); setManufacturerBarcodeConditions([]);
        setSelectedOptionIndex(null);
        setFnsku("");
        setCondition("NEW");
        return null;
      }

      // Fetch every known listing source for this ASIN. created_listings is
      // included even when it has no FNSKU yet, so every Seller Central SKU can
      // be synced and shown as a print option once Amazon returns the X00 code.
      const [fnskuResult, inventoryResult, createdListingsResult] = await Promise.all([
        supabase
          .from('fnsku_map')
          .select('fnsku, condition, seller_sku')
          .eq('seller_id', sellerAuth.seller_id)
          .eq('marketplace_id', sellerAuth.marketplace_id)
          .eq('asin', lookupAsin)
          .order('updated_at', { ascending: false }),
        supabase
          .from('inventory')
          .select('fnsku, sku')
          .eq('user_id', session.user.id)
          .eq('asin', lookupAsin)
          .order('updated_at', { ascending: false }),
        supabase
          .from('active_created_listings' as any)
          .select('fnsku, sku')
          .eq('user_id', session.user.id)
          .eq('asin', lookupAsin)
          .order('updated_at', { ascending: false }),
      ]);

      const fnskuRecords = fnskuResult.data ?? [];
      const inventoryRecords = inventoryResult.data ?? [];
      const createdListingRecords = createdListingsResult.data ?? [];
      const fnskuError = fnskuResult.error;
      const inventoryError = inventoryResult.error;
      const createdListingsError = createdListingsResult.error;

      if (fnskuError) {
        console.error("❌ FNSKU fetch error:", fnskuError);
        setAvailableFnskuOptions([]); setManufacturerBarcodeConditions([]);
        setSelectedOptionIndex(null);
        return null;
      }

      console.log("📦 Found FNSKU records:", fnskuRecords);

      if (inventoryError) {
        console.error("❌ Inventory FNSKU fallback error:", inventoryError);
      }
      if (createdListingsError) {
        console.error("❌ Created listings FNSKU fallback error:", createdListingsError);
      }

      let liveSellerListings: Array<{ sku?: string | null; condition?: string | null }> = [];
      if (allowAutoSync) {
        const { data: liveListingsData, error: liveListingsError } = await supabase.functions.invoke(
          "discover-asin-listings",
          {
            body: { asin: lookupAsin, marketplaceId: sellerAuth.marketplace_id },
            headers: { Authorization: `Bearer ${session.access_token}` },
          },
        );
        if (liveListingsError) {
          console.warn("⚠️ Live Seller Central SKU discovery failed:", liveListingsError);
        } else {
          liveSellerListings = Array.isArray(liveListingsData?.listings) ? liveListingsData.listings : [];
        }
      }

      // Build full list of SKUs known for this ASIN (from any source).
      // FNSKU values from `inventory` / `created_listings` are NOT trusted —
      // they get cross-contaminated when user copies rows. Only `fnsku_map`
      // (keyed per seller_sku) is authoritative.
      const allListingSkus = Array.from(
        new Set(
          [...inventoryRecords, ...createdListingRecords, ...liveSellerListings]
            .map((r: any) => normalizeSku(r?.sku))
            .filter((sku) => sku.length > 0),
        ),
      );

      // Map: seller_sku (uppercased) -> authoritative {fnsku, condition} from fnsku_map.
      // ALSO track rows where fnsku == asin (manufacturer barcode listings) so
      // we can warn the user — these CANNOT be printed by us, and silently
      // hiding them caused customers to print a sibling-condition's label.
      const authoritativeBySku = new Map<string, { fnsku: string; condition: string }>();
      const manufacturerBarcodeRows: string[] = [];
      for (const r of fnskuRecords ?? []) {
        const fn = normalizeFnsku((r as any).fnsku);
        const sku = normalizeSku((r as any).seller_sku);
        const cond = ((r as any).condition ?? "NEW").toString().trim() || "NEW";
        if (!sku) continue;
        if (fn === lookupAsin) {
          manufacturerBarcodeRows.push(cond);
          continue;
        }
        if (!X_FNSKU_PATTERN.test(fn)) continue;
        if (!authoritativeBySku.has(sku)) {
          authoritativeBySku.set(sku, { fnsku: fn, condition: cond });
        }
      }
      setManufacturerBarcodeConditions(Array.from(new Set(manufacturerBarcodeRows)));

      // Identify which discovered SKUs lack an authoritative FNSKU row.
      const skusMissingFnsku = allListingSkus.filter((sku) => !authoritativeBySku.has(sku));
      if (allowAutoSync && skusMissingFnsku.length > 0 && !isSyncingAsin) {
        console.log("🚀 Auto-syncing listing SKU(s) missing authoritative FNSKU:", skusMissingFnsku);
        await runSilentRescueAndRecheck(session, lookupAsin, skusMissingFnsku);
        const refreshed = await autoFetchFnsku(session, lookupAsin, false);
        if (refreshed) return refreshed;
      }

      // Build options strictly from fnsku_map (one option per SKU).
      const merged = new Map<string, FnskuOption>();
      for (const sku of allListingSkus.length > 0 ? allListingSkus : Array.from(authoritativeBySku.keys())) {
        const auth = authoritativeBySku.get(sku);
        if (!auth) continue; // skip SKUs that still have no real FNSKU
        const key = `${auth.fnsku}|${sku}|${auth.condition.toUpperCase()}`;
        if (!merged.has(key)) {
          merged.set(key, { fnsku: auth.fnsku, condition: auth.condition, sku });
        }
      }
      // Include any fnsku_map rows whose SKU wasn't in inventory/created_listings/live.
      for (const [sku, auth] of authoritativeBySku.entries()) {
        const key = `${auth.fnsku}|${sku}|${auth.condition.toUpperCase()}`;
        if (!merged.has(key)) {
          merged.set(key, { fnsku: auth.fnsku, condition: auth.condition, sku });
        }
      }

      const combinedOptions = Array.from(merged.values());

      if (combinedOptions.length > 0) {
        setAvailableFnskuOptions(combinedOptions);
        // SAFETY: never auto-pick when the choice is ambiguous. Auto-selecting
        // index 0 was printing the WRONG sibling condition's FNSKU (e.g. a
        // USED-LIKE-NEW X00 code instead of the NEW listing the user opened).
        // Auto-pick ONLY when there's exactly one printable option AND no
        // sibling manufacturer-barcode listing exists for the same ASIN.
        const ambiguous = combinedOptions.length > 1 || manufacturerBarcodeRows.length > 0;
        if (ambiguous) {
          setSelectedOptionIndex(null);
          setFnsku("");
          setCondition(null);
          console.log(`⚠️ ${combinedOptions.length} printable FNSKU(s) + ${manufacturerBarcodeRows.length} manufacturer-barcode row(s) — user must pick.`);
          return null;
        }
        setSelectedOptionIndex(0);
        setFnsku(combinedOptions[0].fnsku);
        setCondition(combinedOptions[0].condition || "NEW");
        console.log(`✅ Built ${combinedOptions.length} per-SKU FNSKU option(s) for ASIN ${lookupAsin}`);
        return combinedOptions[0].fnsku;
      }

      {
        // 🛑 SAFETY: if fnsku_map shows this ASIN is on manufacturer-barcode mode
        // (fnsku == asin) and we have NO printable X00 sibling, never query
        // live — Amazon would return a stale/unrelated X00 that does NOT match
        // how the listing actually prints. The user must print the ASIN itself
        // (manufacturer barcode) or convert the listing in Seller Central.
        if (manufacturerBarcodeRows.length > 0) {
          console.warn("🛑 ASIN is on manufacturer-barcode mode — refusing to auto-print an X00 FNSKU.");
          setAvailableFnskuOptions([]);
          setSelectedOptionIndex(null);
          setFnsku("");
          setCondition(null);
          return null;
        }

        console.log("⚠️ No FNSKU found in local tables; trying live Amazon lookup.");

        const { data: liveFnsku, error: liveFnskuError } = await supabase.functions.invoke(
          'get-fnsku',
          {
            body: { asin: lookupAsin },
            headers: { Authorization: `Bearer ${session.access_token}` }
          }
        );

        if (liveFnskuError) {
          console.error("❌ Live FNSKU lookup error:", liveFnskuError);
        }

        if (liveFnsku?.fnsku) {
          const liveFn = normalizeFnsku(liveFnsku.fnsku);
          // 🛑 SAFETY: if Amazon returned the ASIN itself, that means manufacturer
          // barcode — never print an X00 we don't have proof of.
          if (liveFn === lookupAsin.toUpperCase()) {
            console.warn("🛑 Live lookup returned ASIN as FNSKU (manufacturer barcode). Not printing.");
            setAvailableFnskuOptions([]);
            setSelectedOptionIndex(null);
            setFnsku("");
            setCondition(null);
            setManufacturerBarcodeConditions(['NEW']);
            return null;
          }
          const option = {
            fnsku: liveFn,
            condition: liveFnsku.condition || "NEW",
          };
          setAvailableFnskuOptions([option]);
          setSelectedOptionIndex(0);
          setFnsku(option.fnsku);
          setCondition(option.condition);
          console.log("✅ Found FNSKU via live Amazon lookup:", option.fnsku);
          return option.fnsku;
        }


        console.log("⚠️ No FNSKU found from cache or live Amazon lookup.");

        // 🔁 AUTOMATIC RESCUE: silently run rescue-inventory-asin to backfill
        // FNSKUs from SP-API Summaries, then re-check the local tables once.
        if (allowAutoSync && !isSyncingAsin) {
          console.log("🚀 Auto-running rescue-inventory-asin to recover FNSKU…");
          const recovered = await runSilentRescueAndRecheck(session, lookupAsin);
          if (recovered) return recovered;
        }

        setAvailableFnskuOptions([]); setManufacturerBarcodeConditions([]);
        setSelectedOptionIndex(null);
        setFnsku("");
        setCondition("NEW");
        return null;
      }
    } catch (error: any) {
      console.error("❌ Could not auto-fetch FNSKU:", error);
      setAvailableFnskuOptions([]); setManufacturerBarcodeConditions([]);
      setSelectedOptionIndex(null);
      return null;
    } finally {
      setIsFetchingFnsku(false);
    }
  };

  const selectFnskuOption = (index: number) => {
    if (index < 0 || index >= availableFnskuOptions.length) return;
    
    const option = availableFnskuOptions[index];
    setSelectedOptionIndex(index);
    setFnsku(option.fnsku);
    setCondition(option.condition || "NEW");
    
    toast({
      title: "Option selected",
      description: `Using FNSKU: ${option.fnsku} (${option.condition || 'NEW'})`,
    });
  };


  const requestPrint = () => {
    if (!fetchedTitle) {
      toast({
        title: "Error",
        description: "Please fetch product data first",
        variant: "destructive",
      });
      return;
    }

    const normalizedFnsku = fnsku.trim().toUpperCase();
    if (!/^X[A-Z0-9]{9}$/.test(normalizedFnsku)) {
      toast({
        title: "FNSKU required",
        description: "Enter or fetch the 10-character X00 FNSKU before printing so the barcode is not the ASIN.",
        variant: "destructive",
      });
      return;
    }

    if (selectedOptionIndex === null && (manufacturerBarcodeConditions.length > 0 || availableFnskuOptions.length > 1)) {
      toast({
        title: "Choose the exact listing",
        description: "This ASIN has multiple listing/barcode paths. Select the exact FNSKU option before printing so we do not print the wrong condition.",
        variant: "destructive",
      });
      return;
    }

    setQuantity("1");
    setQuantityPromptOpen(true);
  };

  const confirmPrintWithQuantity = () => {
    const qty = parseInt(quantity) || 1;
    if (qty < 1 || qty > 100) {
      toast({
        title: "Error",
        description: "Quantity must be between 1 and 100",
        variant: "destructive",
      });
      return;
    }

    const normalizedFnsku = fnsku.trim().toUpperCase();
    const labels: LabelData[] = Array(qty).fill(null).map(() => ({
      asin: asin.toUpperCase(),
      fnsku: normalizedFnsku,
      condition: condition || "NEW",
      title: fetchedTitle,
    }));

    setLabelsForPrint(labels);
    setQuantityPromptOpen(false);
    setLabelDialogOpen(true);
  };

  const resetForm = () => {
    setAsin("");
    setFnsku("");
    setCondition(null);
    setQuantity("1");
    setFetchedTitle("");
    setFetchedImageUrl("");
    setAvailableFnskuOptions([]); setManufacturerBarcodeConditions([]);
    setSelectedOptionIndex(null);
  };

  const updateCondition = async (newCondition: string) => {
    setCondition(newCondition);
    
    // Save to database if we have FNSKU
    if (!fnsku || !asin) return;
    
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;

      // Get seller authorization (home-marketplace aware)
      const sellerAuth = await getPrimarySellerAuth(session.user.id);

      if (!sellerAuth) return;

      // Update condition in database
      await supabase
        .from('fnsku_map')
        .update({ condition: newCondition })
        .eq('seller_id', sellerAuth.seller_id)
        .eq('marketplace_id', sellerAuth.marketplace_id)
        .eq('asin', asin.toUpperCase());

      toast({
        title: "Condition updated",
        description: `Set to ${newCondition} for this ASIN`,
      });
    } catch (error: any) {
      console.error("Error updating condition:", error);
    }
  };

  const viewSyncedData = async () => {
    try {
      setIsLoadingSyncedData(true);
      setViewSyncedDialogOpen(true);
      
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        toast({
          title: "Not authenticated",
          description: "Please log in to view synced data",
          variant: "destructive",
        });
        setSyncedData([]);
        setIsLoadingSyncedData(false);
        return;
      }

      console.log("🔍 Current user ID:", session.user.id);

      // Get seller authorization (home-marketplace aware)
      const sellerAuth = await getPrimarySellerAuth(session.user.id);

      console.log("🔑 Seller authorization found:", sellerAuth);

      if (!sellerAuth) {
        toast({
          title: "No Amazon Seller Account Connected",
          description: "Please go to 'Grant Us Access' in the menu to connect your Amazon seller account first. Then sync your inventory to see FNSKU data here.",
          variant: "destructive",
          duration: 8000,
        });
        setSyncedData([]);
        return;
      }

      // Fetch all synced FNSKU mappings
      const { data, error } = await supabase
        .from('fnsku_map')
        .select('asin, fnsku, condition')
        .eq('seller_id', sellerAuth.seller_id)
        .eq('marketplace_id', sellerAuth.marketplace_id)
        .order('asin', { ascending: true });

      console.log("📦 FNSKU data query result:", { count: data?.length || 0, error });

      if (error) throw error;

      setSyncedData(data || []);

      if (!data || data.length === 0) {
        toast({
          title: "No synced data found",
          description: "Click 'Sync All FNSKUs from Amazon Inventory' button to download your FBA inventory FNSKU mappings.",
          duration: 6000,
        });
      } else {
        toast({
          title: "Data loaded",
          description: `Found ${data.length} FNSKU mappings`,
        });
      }
    } catch (error: any) {
      console.error("❌ Error fetching synced data:", error);
      toast({
        title: "Error loading data",
        description: error.message || "Failed to load synced data. Please try again.",
        variant: "destructive",
      });
      setSyncedData([]);
    } finally {
      setIsLoadingSyncedData(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col">
      <Helmet>
        <title>Label Printing Tool | ArbiProSeller</title>
        <meta name="description" content="Print ASIN barcode labels for thermal printers" />
      </Helmet>
      
      <Navbar />
      
      <main className="flex-grow pt-24 pb-12">
        <div className="container mx-auto px-4 max-w-2xl">
          <div className="mb-6">
            <h1 className="text-3xl font-bold">Label Printing Tool</h1>
            <p className="text-muted-foreground mt-1">
              Generate FNSKU barcode labels for thermal printers
            </p>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Product Information</CardTitle>
              <CardDescription>
                Enter ASIN to retrieve product title, then specify how many labels to print
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* ASIN Input */}
              <div className="space-y-2">
                <label className="text-sm font-medium">ASIN</label>
                <div className="flex gap-2">
                  <Input 
                    placeholder="Enter ASIN (e.g., B07XYZ1234)" 
                    value={asin} 
                    onChange={(e) => handleAsinChange(e.target.value)}
                    className="flex-1 uppercase"
                    maxLength={10}
                  />
                  <Button 
                    onClick={fetchProductData} 
                    disabled={isFetching || !asin}
                    variant="outline"
                  >
                    {isFetching ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Fetching...
                      </>
                    ) : (
                      "Fetch Product"
                    )}
                  </Button>
                </div>
              </div>

              {/* Manufacturer-barcode warning — printed labels would be wrong condition */}
              {/* Central FBA eligibility banner — same content the extension shows */}
              <FbaReadinessTracker
                eligibility={fbaElig.data}
                loading={fbaElig.loading}
                onRecheck={fbaElig.recheck}
                onRunDryRun={fbaElig.runDryRun}
                dryRunLoading={fbaElig.dryRunLoading}
              />

              {manufacturerBarcodeConditions.length > 0 && (
                <div className="p-3 bg-rose-50 dark:bg-rose-900/20 border border-rose-300 dark:border-rose-800 rounded-lg text-sm">
                  <p className="font-semibold text-rose-700 dark:text-rose-300">
                    ⚠ This ASIN has a manufacturer-barcode listing — be careful which label you print.
                  </p>
                  <p className="text-rose-700 dark:text-rose-300 mt-1">
                    The {manufacturerBarcodeConditions.join(', ')} listing for this ASIN uses Amazon's <strong>manufacturer barcode</strong> mode (FNSKU = ASIN), so it has no printable X00 label.
                    Any FNSKU shown below belongs to a <strong>different condition variant</strong>. Do not stick that label on a unit you intend to send as {manufacturerBarcodeConditions[0]} — Amazon will reject the shipment (the brand-registry error you just saw).
                  </p>
                  <p className="text-rose-700 dark:text-rose-300 mt-1 text-xs">
                    Fix: convert the listing to use Amazon barcode in Seller Central → Manage Inventory → Edit → Offer → Product ID type → "Amazon barcode (FNSKU)", then re-sync.
                  </p>
                </div>
              )}

              {/* Selected FNSKU Display */}
              {fnsku && selectedOptionIndex !== null && (
                <div className="p-4 bg-gradient-to-r from-indigo-50 to-blue-50 dark:from-indigo-950/40 dark:to-blue-950/40 border-2 border-indigo-400 dark:border-indigo-600 rounded-lg shadow-sm ring-2 ring-indigo-300/40 dark:ring-indigo-700/40">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold uppercase tracking-wide bg-indigo-600 text-white">
                      🖨 Selected for Printing
                    </span>
                  </div>
                  <p className="text-sm font-mono font-semibold text-indigo-900 dark:text-indigo-200">
                    FNSKU: {fnsku} • Condition: {condition || 'NEW'}
                  </p>
                  {availableFnskuOptions[selectedOptionIndex]?.sku && (
                    <p className="text-sm font-mono text-indigo-800 dark:text-indigo-300 mt-1">
                      SKU: {availableFnskuOptions[selectedOptionIndex]?.sku}
                    </p>
                  )}
                  <p className="text-xs text-indigo-700 dark:text-indigo-400 mt-2">
                    ✓ This FNSKU and condition will be used for the label
                  </p>
                </div>
              )}

              {/* FNSKU Display when no options available */}
              {fnsku && selectedOptionIndex === null && (
                <div className="p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg">
                  <label className="text-sm font-medium block mb-1 text-green-700 dark:text-green-400">
                    FNSKU (X00 Code)
                  </label>
                  <p className="text-sm font-mono text-green-900 dark:text-green-300">{fnsku}</p>
                  <p className="text-xs text-green-600 dark:text-green-500 mt-1">
                    ✓ FNSKU will be used for barcode printing
                  </p>
                </div>
              )}

              {fetchedTitle && (
                <div className="space-y-2">
                  <label className="text-sm font-medium">FNSKU (X00 Code)</label>
                  <Input
                    placeholder="Enter X00 code from Seller Central"
                    value={fnsku}
                    onChange={(e) => setFnsku(e.target.value.trim().toUpperCase())}
                    className="font-mono uppercase"
                    maxLength={10}
                    disabled={isFetchingFnsku}
                  />
                  <p className="text-xs text-muted-foreground">
                    Labels now require an X00 FNSKU; ASIN fallback printing is blocked.
                  </p>
                </div>
              )}

              {/* Product Title & Image Display */}
              {fetchedTitle && (
                <div className="p-3 bg-muted rounded-lg space-y-3">
                  <div className="flex gap-4">
                    {/* Product Image */}
                    {fetchedImageUrl && (
                      <div className="flex-shrink-0">
                        <img 
                          src={fetchedImageUrl} 
                          alt={fetchedTitle}
                          className="w-20 h-20 object-contain rounded border bg-white"
                        />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <label className="text-sm font-medium block mb-1">Product Title</label>
                      <p className="text-sm">{fetchedTitle}</p>
                      <p className="text-xs text-muted-foreground mt-1">ASIN: {asin.toUpperCase()}</p>
                    </div>
                  </div>
                  {!fnsku && (
                    <div className="text-sm text-yellow-600 dark:text-yellow-400 bg-yellow-50 dark:bg-yellow-900/20 p-2 rounded space-y-2">
                      {isSyncingAsin ? (
                        <div className="flex items-center gap-2">
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Auto-syncing this ASIN with Amazon to recover FNSKU…
                        </div>
                      ) : (
                          <div>
                          ⚠️ No printable X00 FNSKU found yet. Printing is blocked to prevent a wrong label.
                          <p className="text-xs mt-1 opacity-80">
                            Enter the exact X00 FNSKU from Seller Central, or retry the live sync.
                          </p>
                        </div>
                      )}
                      <Button
                        onClick={syncAsinFromAmazon}
                        disabled={isSyncingAsin || !asin}
                        size="sm"
                        className="gap-2 bg-emerald-500 hover:bg-emerald-600 text-white"
                      >
                        {isSyncingAsin ? (
                          <><Loader2 className="w-4 h-4 animate-spin" /> Syncing…</>
                        ) : (
                          <><RefreshCw className="w-4 h-4" /> Retry sync from Amazon</>
                        )}
                      </Button>
                    </div>
                  )}
                </div>
              )}

              {/* Available FNSKU Options - Show all conditions for this ASIN */}
              {fetchedTitle && availableFnskuOptions.length > 0 && (
                <div className="space-y-2">
                  <label className="text-sm font-medium">
                    Available Inventory Options ({availableFnskuOptions.length})
                  </label>
                  <p className="text-xs text-muted-foreground mb-2">
                    Tap the exact FNSKU/condition you want to print:
                  </p>
                  <div className="space-y-3">
                    {availableFnskuOptions.map((option, index) => {
                      const cond = (option.condition || 'NEW').toUpperCase();
                      const isUsed = cond.includes('USED');
                      const isCollectible = cond.includes('COLLECTIBLE');
                      const isSelected = selectedOptionIndex === index;
                      const accent = isUsed
                        ? { border: 'border-l-orange-500', badge: 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300', dot: 'bg-orange-500' }
                        : isCollectible
                        ? { border: 'border-l-purple-500', badge: 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300', dot: 'bg-purple-500' }
                        : { border: 'border-l-green-500', badge: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300', dot: 'bg-green-500' };
                      return (
                        <div
                          key={`${option.fnsku}-${index}`}
                          onClick={() => selectFnskuOption(index)}
                          className={`relative p-4 pl-5 rounded-lg border-2 border-l-[6px] ${accent.border} cursor-pointer transition-all ${
                            isSelected
                              ? 'bg-green-50 dark:bg-green-900/30 border-green-500 dark:border-green-600 ring-2 ring-green-500/30 shadow-sm'
                              : 'bg-card hover:bg-muted/60 border-border hover:border-primary/40'
                          }`}
                        >
                          {isSelected && (
                            <span className="absolute top-2 right-2 inline-flex items-center gap-1 rounded-full bg-green-600 text-white text-[10px] font-semibold px-2 py-0.5 shadow">
                              ✓ SELECTED
                            </span>
                          )}
                          <div className="flex items-start gap-3">
                            <div className={`mt-1 h-6 w-6 shrink-0 rounded-full ${accent.dot} text-white text-xs font-bold flex items-center justify-center`}>
                              {index + 1}
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2 mb-1">
                                <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-bold tracking-wide ${accent.badge}`}>
                                  {option.condition || 'NEW'}
                                </span>
                                <span className="font-mono text-sm font-semibold text-foreground">
                                  {option.fnsku}
                                </span>
                              </div>
                              {option.sku && (
                                <div className="text-[11px] text-muted-foreground mt-1">
                                  <span className="uppercase tracking-wide mr-1">Seller SKU:</span>
                                  <span className="font-mono break-all">{option.sku}</span>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* No FNSKU options found - show condition dropdown as fallback */}
              {fetchedTitle && availableFnskuOptions.length === 0 && (
                <div className="space-y-2">
                  <label className="text-sm font-medium">Product Condition</label>
                  <Select 
                    value={condition || "NEW"} 
                    onValueChange={updateCondition}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select condition" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="NEW">NEW</SelectItem>
                      <SelectItem value="USED - LIKE NEW">USED - LIKE NEW</SelectItem>
                      <SelectItem value="USED - VERY GOOD">USED - VERY GOOD</SelectItem>
                      <SelectItem value="USED - GOOD">USED - GOOD</SelectItem>
                      <SelectItem value="USED - ACCEPTABLE">USED - ACCEPTABLE</SelectItem>
                      <SelectItem value="COLLECTIBLE - LIKE NEW">COLLECTIBLE - LIKE NEW</SelectItem>
                      <SelectItem value="COLLECTIBLE - VERY GOOD">COLLECTIBLE - VERY GOOD</SelectItem>
                      <SelectItem value="COLLECTIBLE - GOOD">COLLECTIBLE - GOOD</SelectItem>
                      <SelectItem value="COLLECTIBLE - ACCEPTABLE">COLLECTIBLE - ACCEPTABLE</SelectItem>
                      <SelectItem value="RENEWED">RENEWED</SelectItem>
                      <SelectItem value="OEM">OEM</SelectItem>
                      <SelectItem value="CLUB">CLUB</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    No synced inventory found. Select condition manually.
                  </p>
                </div>
              )}

              {/* Action Buttons */}
              <div className="space-y-2 pt-4">
                <div className="flex gap-2">
                  <Button 
                    onClick={requestPrint}
                    disabled={!fetchedTitle || !fnsku || isFetchingFnsku}
                    className="flex-1"
                  >
                    <Printer className="w-4 h-4 mr-2" />
                    Print Labels
                  </Button>
                  <Button 
                    onClick={resetForm}
                    variant="outline"
                  >
                    <RefreshCw className="w-4 h-4 mr-2" />
                    Reset
                  </Button>
                </div>
                
                <div className="border-t pt-4 space-y-2">
                  <Button 
                    onClick={viewSyncedData} 
                    variant="outline" 
                    className="w-full"
                  >
                    <Database className="w-4 h-4 mr-2" />
                    View Synced ASIN & FNSKU Data
                  </Button>
                  <p className="text-xs text-muted-foreground text-center mt-2">
                    Inventory syncs automatically every 4 hours. FNSKU lookups are instant from cache.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

        </div>
      </main>

      <Footer />

      <ThermalLabelPrintDialog
        open={labelDialogOpen}
        onOpenChange={setLabelDialogOpen}
        labels={labelsForPrint}
      />

      {/* Quantity prompt before opening the print dialog */}
      <Dialog open={quantityPromptOpen} onOpenChange={setQuantityPromptOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>How many labels?</DialogTitle>
            <DialogDescription>
              Enter the number of copies to print (1–100).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <label className="text-sm font-medium">Number of Labels</label>
            <Input
              type="number"
              min="1"
              max="100"
              autoFocus
              placeholder="How many labels?"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  confirmPrintWithQuantity();
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setQuantityPromptOpen(false)}>
              Cancel
            </Button>
            <Button onClick={confirmPrintWithQuantity}>
              <Printer className="w-4 h-4 mr-2" />
              Print
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* View Synced Data Dialog */}
      <Dialog open={viewSyncedDialogOpen} onOpenChange={setViewSyncedDialogOpen}>
        <DialogContent className="max-w-4xl max-h-[80vh]">
          <DialogHeader>
            <DialogTitle>Synced ASIN & FNSKU Data</DialogTitle>
            <DialogDescription>
              All FNSKU mappings retrieved from your Amazon FBA inventory
            </DialogDescription>
          </DialogHeader>
          
          {isLoadingSyncedData ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin" />
            </div>
          ) : syncedData.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              No synced data found. Run the sync first to download your FBA inventory.
            </div>
          ) : (
            <ScrollArea className="h-[500px] w-full rounded-lg bg-amber-50 dark:bg-amber-950/20 p-4">
              <Table>
                <TableHeader>
                  <TableRow className="border-amber-200 dark:border-amber-800">
                    <TableHead className="text-amber-900 dark:text-amber-100">ASIN</TableHead>
                    <TableHead className="text-amber-900 dark:text-amber-100">FNSKU (X00)</TableHead>
                    <TableHead className="text-amber-900 dark:text-amber-100">Condition</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {syncedData.map((item, index) => (
                    <TableRow key={index} className="border-amber-200 dark:border-amber-800 hover:bg-amber-100 dark:hover:bg-amber-900/30">
                      <TableCell className="font-mono text-amber-900 dark:text-amber-100">{item.asin}</TableCell>
                      <TableCell className="font-mono text-green-700 dark:text-green-400">
                        {item.fnsku}
                      </TableCell>
                      <TableCell className="text-sm text-amber-700 dark:text-amber-300">
                        {item.condition || 'N/A'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollArea>
          )}
          
          <div className="text-sm text-muted-foreground text-center border-t pt-4">
            Total: {syncedData.length} FNSKU mappings
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default LabelPrinting;