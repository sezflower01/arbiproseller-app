/**
 * ============================================================================
 * UNIFIED COGS RESOLVER (client-side)
 * ============================================================================
 *
 * Single source of truth for resolving a per-order unit cost on the client.
 * Mirrors the SQL function `public.resolve_unit_cost_v1` byte-for-byte so
 * that Live Sales / Sales Report (client) and P&L / CSV export (RPC) return
 * the SAME number for the same (ASIN, SKU, order_date).
 *
 * Precedence (locked — historical sales must not recalculate from a later
 * purchase/inventory edit):
 *   1. sales_orders.unit_cost_at_sale / locked sales_orders.unit_cost snapshot.
 *   2. asin_cost_overrides (newest effective_from <= order_date).
 *   3. created_listing_purchases newest purchase_date <= order_date (SKU first).
 *   4. created_listings newest date_created <= order_date (SKU first, then ASIN).
 *   5. inventory.cost only as low-confidence final fallback.
 *   6. unresolved → 0.
 *
 * DO NOT add new ladders elsewhere. If you need a unit cost on the client,
 * use buildCogsResolver().
 * ============================================================================
 */

import { supabase } from "@/integrations/supabase/client";
import {
  getListingUnitCost,
  getInventoryUnitCost,
  type CreatedListingCostRow,
  type InventoryCostRow,
} from "@/lib/cost-contract";

export type CogsSource =
  | "salesOrders"
  | "manualOverride"
  | "costHistory"
  | "purchaseBatch"
  | "listingsHistorical"
  | "listingsFallback"
  | "inventoryFallback"
  | "unresolved";

interface CostHistoryEntry {
  asin?: string | null;
  sku?: string | null;
  cost: number;
  effective_date: string; // YYYY-MM-DD
  recorded_at: string;    // timestamptz iso
  id?: string | null;
}

export interface OrderForCogs {
  asin?: string | null;
  sku?: string | null;
  order_date?: string | null;
  unit_cost?: number | null;
  unit_cost_at_sale?: number | null;
  cost_source_at_sale?: string | null;
  cost_locked?: boolean | null;
}

export interface ResolvedCost {
  unitCost: number;
  source: CogsSource;
}

const isValidAsin = (asin?: string | null): asin is string =>
  !!asin && asin !== "PENDING" && asin !== "UNKNOWN";

interface ListingRow extends CreatedListingCostRow {
  asin?: string | null;
  sku?: string | null;
  date_created?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  id?: string | null;
}

interface OverrideEntry {
  effective_from: string;
  unit_cost: number;
}

interface PurchaseEntry {
  asin?: string | null;
  sku?: string | null;
  unit_cost: number;
  purchase_date: string;
  created_at?: string | null;
  id?: string | null;
}

interface HistoricalCostCandidate {
  unitCost: number;
  source: CogsSource;
  costTs: string;
  createdAt: string;
  tieRank: number;
  id: string;
}

export interface CogsResolver {
  resolve(order: OrderForCogs): ResolvedCost;
}

const BATCH = 100;

async function fetchInBatches<T extends string, R>(
  keys: T[],
  fetcher: (batch: T[]) => Promise<R[] | null | undefined>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < keys.length; i += BATCH) {
    const rows = await fetcher(keys.slice(i, i + BATCH));
    if (rows && rows.length) out.push(...rows);
  }
  return out;
}

/**
 * Picks the newest listing row for a key using date_created DESC NULLS LAST,
 * then created_at DESC, then id DESC — mirrors the SQL ORDER BY exactly.
 */
function pickNewestListing(rows: ListingRow[]): ListingRow | undefined {
  if (!rows.length) return undefined;
  const sorted = [...rows].sort((a, b) => {
    const ad = a.date_created || "";
    const bd = b.date_created || "";
    if (ad !== bd) {
      if (!ad) return 1;
      if (!bd) return -1;
      return bd.localeCompare(ad);
    }
    const ac = a.created_at || "";
    const bc = b.created_at || "";
    if (ac !== bc) return bc.localeCompare(ac);
    return (b.id || "").localeCompare(a.id || "");
  });
  // First with a usable unit cost
  for (const row of sorted) {
    const u = getListingUnitCost(row);
    if (u !== null && u > 0) return row;
  }
  return undefined;
}

function orderDateEndBoundary(orderDate: string | null): string | null {
  if (!orderDate) return null;
  const datePart = orderDate.slice(0, 10);
  const d = new Date(`${datePart}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

function listingDate(row: ListingRow): string {
  return row.date_created || row.created_at?.slice(0, 10) || "";
}

function pickHistoricalListing(rows: ListingRow[], orderDate: string | null): ListingRow | undefined {
  if (!orderDate) return pickNewestListing(rows);
  const datePart = orderDate.slice(0, 10);
  return pickNewestListing(rows.filter((row) => {
    const d = listingDate(row);
    return !!d && d <= datePart;
  }));
}

function pickHistoricalPurchase(rows: PurchaseEntry[], orderDate: string | null): PurchaseEntry | undefined {
  if (!rows.length || !orderDate) return undefined;
  const boundary = orderDateEndBoundary(orderDate);
  if (!boundary) return undefined;
  const sorted = rows
    .filter((row) => Number(row.unit_cost) > 0 && row.purchase_date < boundary)
    .sort((a, b) => {
      if (a.purchase_date !== b.purchase_date) return b.purchase_date.localeCompare(a.purchase_date);
      const ac = a.created_at || "";
      const bc = b.created_at || "";
      if (ac !== bc) return bc.localeCompare(ac);
      return (b.id || "").localeCompare(a.id || "");
    });
  return sorted[0];
}

function pickHistoricalCost(
  purchases: PurchaseEntry[],
  listings: ListingRow[],
  costHistory: CostHistoryEntry[],
  orderDate: string | null,
): HistoricalCostCandidate | undefined {
  if (!orderDate) {
    const row = pickNewestListing(listings);
    if (!row) return undefined;
    const unit = getListingUnitCost(row);
    return unit !== null && unit > 0
      ? {
          unitCost: unit,
          source: "listingsFallback",
          costTs: listingDate(row),
          createdAt: row.created_at || "",
          tieRank: 1,
          id: row.id || "",
        }
      : undefined;
  }

  const boundary = orderDateEndBoundary(orderDate);
  if (!boundary) return undefined;
  const datePart = orderDate.slice(0, 10);
  const candidates: HistoricalCostCandidate[] = [];

  // Tier A — immutable cost_history (preferred). Filter: effective_date AND recorded_at both <= order_date.
  for (const row of costHistory) {
    const unit = Number(row.cost) || 0;
    if (unit <= 0) continue;
    const eff = (row.effective_date || "").slice(0, 10);
    const rec = (row.recorded_at || "").slice(0, 10);
    if (!eff || eff > datePart) continue;
    if (rec && rec > datePart) continue;
    candidates.push({
      unitCost: unit,
      source: "costHistory",
      costTs: `${eff}T00:00:00.000Z`,
      createdAt: row.recorded_at || "",
      tieRank: -1, // beats purchases/listings on tie
      id: row.id || "",
    });
  }

  // Tier B — purchase batches.
  for (const row of purchases) {
    const unit = Number(row.unit_cost) || 0;
    if (unit <= 0 || !row.purchase_date || row.purchase_date >= boundary) continue;
    candidates.push({
      unitCost: unit,
      source: "purchaseBatch",
      costTs: row.purchase_date,
      createdAt: row.created_at || "",
      tieRank: 0,
      id: row.id || "",
    });
  }

  // Tier C — created_listings with STRICT 3-clause guard:
  //   effective_date <= order_date
  //   AND created_at::date <= order_date    (row physically existed)
  //   AND updated_at::date <= order_date    (cost wasn't edited after the sale)
  for (const row of listings) {
    const d = listingDate(row);
    if (!d || d > datePart) continue;
    const createdDay = row.created_at?.slice(0, 10) || "";
    if (createdDay && createdDay > datePart) continue;
    const updatedDay = row.updated_at?.slice(0, 10) || "";
    if (updatedDay && updatedDay > datePart) continue;
    const unit = getListingUnitCost(row);
    if (unit === null || unit <= 0) continue;
    candidates.push({
      unitCost: unit,
      source: "listingsHistorical",
      costTs: row.date_created ? `${row.date_created}T00:00:00.000Z` : row.created_at || d,
      createdAt: row.created_at || "",
      tieRank: 1,
      id: row.id || "",
    });
  }

  return candidates.sort((a, b) => {
    if (a.costTs !== b.costTs) return b.costTs.localeCompare(a.costTs);
    if (a.createdAt !== b.createdAt) return b.createdAt.localeCompare(a.createdAt);
    if (a.tieRank !== b.tieRank) return a.tieRank - b.tieRank;
    return b.id.localeCompare(a.id);
  })[0];
}

function pickInventoryRow(rows: InventoryCostRow[]): InventoryCostRow | undefined {
  for (const row of rows) {
    const u = getInventoryUnitCost(row);
    if (u !== null && u > 0) return row;
  }
  return undefined;
}

/**
 * Build a resolver scoped to a user that pre-loads every fallback source for
 * the supplied ASINs and SKUs in one batched pass.
 *
 * Pass the FULL set of (asin, sku) pairs that may appear in the rows you are
 * about to display — the resolver does no further network calls after build.
 */
export async function buildCogsResolver(
  userId: string,
  orders: Array<Pick<OrderForCogs, "asin" | "sku">>,
): Promise<CogsResolver> {
  const asins = [...new Set(orders.map((o) => o.asin).filter(isValidAsin))] as string[];
  const skus = [
    ...new Set(
      orders
        .filter((o) => !!o.sku)
        .map((o) => o.sku as string),
    ),
  ];

  // ---- created_listings by ASIN ----
  const listingRowsByAsin = new Map<string, ListingRow[]>();
  const listingById = new Map<string, ListingRow>();
  if (asins.length) {
    const rows = await fetchInBatches(asins, async (batch) => {
      const { data } = await supabase
        .from("created_listings")
        .select("asin, sku, cost, amount, units, date_created, created_at, updated_at, id")
        .eq("user_id", userId)
        .in("asin", batch);
      return data as ListingRow[] | null;
    });
    for (const r of rows) {
      const k = (r as any).asin as string | null;
      if (r.id) listingById.set(String(r.id), r);
      if (!k) continue;
      const arr = listingRowsByAsin.get(k) || [];
      arr.push(r);
      listingRowsByAsin.set(k, arr);
    }
  }

  // ---- created_listings by SKU ----
  const listingRowsBySku = new Map<string, ListingRow[]>();
  if (skus.length) {
    const rows = await fetchInBatches(skus, async (batch) => {
      const { data } = await supabase
        .from("created_listings")
        .select("asin, sku, cost, amount, units, date_created, created_at, updated_at, id")
        .eq("user_id", userId)
        .in("sku", batch);
      return data as ListingRow[] | null;
    });
    for (const r of rows) {
      const k = (r as any).sku as string | null;
      if (r.id) listingById.set(String(r.id), r);
      if (!k) continue;
      const arr = listingRowsBySku.get(k) || [];
      arr.push(r);
      listingRowsBySku.set(k, arr);
    }
  }

  // ---- created_listing_purchases by ASIN/SKU ----
  const purchasesByAsin = new Map<string, PurchaseEntry[]>();
  const purchasesBySku = new Map<string, PurchaseEntry[]>();
  const listingIds = [...listingById.keys()];
  if (listingIds.length) {
    const purchaseRows = await fetchInBatches(listingIds, async (batch) => {
      const { data } = await supabase
        .from("created_listing_purchases")
        .select("id, listing_id, unit_cost, purchase_date, created_at")
        .eq("user_id", userId)
        .in("listing_id", batch)
        .gt("unit_cost", 0);
      return data as Array<PurchaseEntry & { listing_id: string }> | null;
    });

    for (const row of purchaseRows as Array<PurchaseEntry & { listing_id: string }>) {
      const listing = listingById.get(String(row.listing_id));
      if (!listing) continue;
      const entry: PurchaseEntry = {
        asin: listing.asin,
        sku: listing.sku,
        unit_cost: Number(row.unit_cost),
        purchase_date: row.purchase_date,
        created_at: row.created_at,
        id: row.id,
      };
      if (entry.asin) {
        const arr = purchasesByAsin.get(entry.asin) || [];
        arr.push(entry);
        purchasesByAsin.set(entry.asin, arr);
      }
      if (entry.sku) {
        const arr = purchasesBySku.get(entry.sku) || [];
        arr.push(entry);
        purchasesBySku.set(entry.sku, arr);
      }
    }
  }

  // ---- inventory by ASIN ----
  const inventoryByAsin = new Map<string, InventoryCostRow>();
  if (asins.length) {
    const rows = await fetchInBatches(asins, async (batch) => {
      const { data } = await supabase
        .from("inventory")
        .select("asin, sku, cost, amount, units")
        .eq("user_id", userId)
        .in("asin", batch);
      return data as (InventoryCostRow & { asin?: string })[] | null;
    });
    const grouped = new Map<string, InventoryCostRow[]>();
    for (const r of rows as Array<InventoryCostRow & { asin?: string }>) {
      if (!r.asin) continue;
      const arr = grouped.get(r.asin) || [];
      arr.push(r);
      grouped.set(r.asin, arr);
    }
    for (const [asin, group] of grouped) {
      const picked = pickInventoryRow(group);
      if (picked) inventoryByAsin.set(asin, picked);
    }
  }

  // ---- inventory by SKU ----
  const inventoryBySku = new Map<string, InventoryCostRow>();
  if (skus.length) {
    const rows = await fetchInBatches(skus, async (batch) => {
      const { data } = await supabase
        .from("inventory")
        .select("asin, sku, cost, amount, units")
        .eq("user_id", userId)
        .in("sku", batch);
      return data as (InventoryCostRow & { sku?: string })[] | null;
    });
    const grouped = new Map<string, InventoryCostRow[]>();
    for (const r of rows as Array<InventoryCostRow & { sku?: string }>) {
      if (!r.sku) continue;
      const arr = grouped.get(r.sku) || [];
      arr.push(r);
      grouped.set(r.sku, arr);
    }
    for (const [sku, group] of grouped) {
      const picked = pickInventoryRow(group);
      if (picked) inventoryBySku.set(sku, picked);
    }
  }

  // ---- asin_cost_overrides (full timeline per ASIN) ----
  const overridesByAsin = new Map<string, OverrideEntry[]>();
  if (asins.length) {
    for (let i = 0; i < asins.length; i += 200) {
      const chunk = asins.slice(i, i + 200);
      const { data } = await supabase
        .from("asin_cost_overrides")
        .select("asin, unit_cost, effective_from")
        .eq("user_id", userId)
        .in("asin", chunk)
        .order("effective_from", { ascending: true });
      for (const row of (data || []) as Array<{
        asin: string;
        unit_cost: number;
        effective_from: string;
      }>) {
        const list = overridesByAsin.get(row.asin) || [];
        list.push({
          effective_from: row.effective_from,
          unit_cost: Number(row.unit_cost),
        });
        overridesByAsin.set(row.asin, list);
      }
    }
  }

  // ---- cost_history (immutable cost ledger) by ASIN and SKU ----
  const costHistoryByAsin = new Map<string, CostHistoryEntry[]>();
  const costHistoryBySku = new Map<string, CostHistoryEntry[]>();
  if (asins.length) {
    const rows = await fetchInBatches(asins, async (batch) => {
      const { data } = await supabase
        .from("cost_history")
        .select("id, asin, sku, cost, effective_date, recorded_at")
        .eq("user_id", userId)
        .in("asin", batch);
      return data as CostHistoryEntry[] | null;
    });
    for (const r of rows) {
      if (r.asin) (costHistoryByAsin.get(r.asin) || costHistoryByAsin.set(r.asin, []).get(r.asin)!).push(r);
    }
  }
  if (skus.length) {
    const rows = await fetchInBatches(skus, async (batch) => {
      const { data } = await supabase
        .from("cost_history")
        .select("id, asin, sku, cost, effective_date, recorded_at")
        .eq("user_id", userId)
        .in("sku", batch);
      return data as CostHistoryEntry[] | null;
    });
    for (const r of rows) {
      if (r.sku) (costHistoryBySku.get(r.sku) || costHistoryBySku.set(r.sku, []).get(r.sku)!).push(r);
    }
  }

  const resolveOverride = (asin: string, orderDate: string | null): number => {
    const timeline = overridesByAsin.get(asin);
    if (!timeline?.length || !orderDate) return 0;
    let chosen = 0;
    for (const entry of timeline) {
      if (entry.effective_from <= orderDate) chosen = entry.unit_cost;
      else break;
    }
    return chosen > 0 ? chosen : 0;
  };

  return {
    resolve(order: OrderForCogs): ResolvedCost {
      const asin = isValidAsin(order.asin) ? order.asin : null;
      const sku = order.sku || null;
      const orderDate = order.order_date || null;

      // 1. Locked sale-time snapshot. Later purchases/inventory edits must not rewrite old sales.
      const saleSnap = Number(order.unit_cost_at_sale) || 0;
      if (saleSnap > 0 && order.cost_locked === true) {
        return { unitCost: saleSnap, source: "salesOrders" };
      }
      const legacySnap = Number(order.unit_cost) || 0;
      if (legacySnap > 0 && order.cost_locked === true) return { unitCost: legacySnap, source: "salesOrders" };

      // 2. manual override (date-aware).
      if (asin) {
        const ov = resolveOverride(asin, orderDate);
        if (ov > 0) return { unitCost: ov, source: "manualOverride" };
      }

      // 3. historical cost event before the sale date (SKU first, then ASIN).
      // Purchases and created_listings are one timeline: an ancient purchase
      // batch must not outrank a newer listing cost entered before the sale.
      if (sku) {
        const row = pickHistoricalCost(purchasesBySku.get(sku) || [], listingRowsBySku.get(sku) || [], costHistoryBySku.get(sku) || [], orderDate);
        if (row && row.unitCost > 0) return { unitCost: row.unitCost, source: row.source };
      }
      if (asin) {
        const row = pickHistoricalCost(purchasesByAsin.get(asin) || [], listingRowsByAsin.get(asin) || [], costHistoryByAsin.get(asin) || [], orderDate);
        if (row && row.unitCost > 0) return { unitCost: row.unitCost, source: row.source };
      }

      // 3.5. Row-stamped unit_cost from a previous sync/backfill. Even when
      // cost_locked is false, a positive unit_cost on the order row was
      // written from a real historical source (created_listings / purchase /
      // cost_history). Trust it BEFORE falling through to current inventory,
      // which can carry a wrong / partial cost (e.g. inventory.cost=$1 left
      // over from a corrupted writer) and produce $1/unit COGS for pending
      // orders whose locked-cost columns aren't filled in yet.
      if (legacySnap > 0) {
        return { unitCost: legacySnap, source: "salesOrders" };
      }

      // 4. Current inventory fallback only after historical sources are unavailable.
      if (sku) {
        const irow = inventoryBySku.get(sku);
        if (irow) {
          const u = getInventoryUnitCost(irow);
          if (u !== null && u > 0) return { unitCost: u, source: "inventoryFallback" };
        }
      }
      if (asin) {
        const row = inventoryByAsin.get(asin);
        if (row) {
          const u = getInventoryUnitCost(row);
          if (u !== null && u > 0) return { unitCost: u, source: "inventoryFallback" };
        }
      }

      // 5. unresolved
      return { unitCost: 0, source: "unresolved" };
    },
  };
}
