import { supabase } from "@/integrations/supabase/client";
import { getInventoryUnitCost, getListingTotalCost, getListingUnitCost } from "@/lib/cost-contract";

export interface InventoryValuationTotals {
  value: number;
  units: number;
  skus: number;
  available: number;
  reserved: number;
  inbound: number;
  unfulfilled: number;
  availableValue: number;
  reservedValue: number;
  inboundValue: number;
  unfulfilledValue: number;
  lowStock: number;
  totalRows: number;
  rowsStale24h: number;
  mostRecentSync: string | null;
}

type CostEntry = {
  unitCost: number | null;
  totalCost: number | null;
  units: number | null;
};

type InventoryRow = {
  id: string;
  available: number | null;
  reserved: number | null;
  inbound: number | null;
  unfulfilled: number | null;
  cost: number | null;
  amount: number | null;
  units: number | null;
  unit_cost_manual: boolean | null;
  last_summaries_at: string | null;
  listing_status: string | null;
  asin: string;
  sku: string;
  created_at: string;
};

type ListingRow = {
  id: string;
  asin: string | null;
  sku: string | null;
  cost: number | null;
  amount: number | null;
  units: number | null;
  created_at: string | null;
  updated_at: string | null;
};

type OverrideRow = {
  asin: string;
  unit_cost: number;
  effective_from: string;
};

/**
 * Same override source P&L's resolve_unit_cost_v1 treats as top-priority
 * (after the sale-time snapshot, which doesn't apply to unsold stock).
 * Wiring it in here too means Inventory Valuation and P&L agree on one
 * number per ASIN instead of drifting apart.
 */
async function fetchAsinCostOverrides(userId: string): Promise<Map<string, number>> {
  const { data, error } = await supabase
    .from("asin_cost_overrides")
    .select("asin, unit_cost, effective_from")
    .eq("user_id", userId)
    .order("effective_from", { ascending: true });
  const map = new Map<string, number>();
  if (error || !data) return map;
  const today = new Date().toISOString().slice(0, 10);
  for (const row of data as OverrideRow[]) {
    if (!row.asin) continue;
    const eff = (row.effective_from || "").slice(0, 10);
    const cost = Number(row.unit_cost);
    if (eff && eff <= today && cost > 0) map.set(row.asin, cost);
  }
  return map;
}

async function fetchAllKeyset<T extends { id: string; created_at: string | null }>(table: string, columns: string, userId: string): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  const seenIds = new Set<string>();
  let lastCreatedAt: string | null = null;
  let lastId: string | null = null;

  for (let page = 0; page < 50; page += 1) {
    let query = supabase
      .from(table as any)
      .select(columns)
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(PAGE);

    if (lastCreatedAt && lastId) {
      query = query.or(`created_at.lt.${lastCreatedAt},and(created_at.eq.${lastCreatedAt},id.lt.${lastId})`);
    }

    const { data, error } = await query;
    if (error) throw error;
    if (!data || data.length === 0) break;
    const batch = data as unknown as T[];
    for (const row of batch) {
      if (row.id && !seenIds.has(row.id)) {
        seenIds.add(row.id);
        out.push(row);
      }
    }

    const lastRow = batch[batch.length - 1];
    lastCreatedAt = lastRow.created_at;
    lastId = lastRow.id;
    if (data.length < PAGE) break;
  }
  return out;
}

/**
 * Read the server-written summary row. Returns null when missing or stale
 * beyond `maxAgeSeconds` (default 30 min) — caller falls back to live compute.
 *
 * Phase 1 of multi-client CPU scaling: 5 browser tabs share ONE row instead
 * of each scanning inventory + created_listings.
 */
async function readInventoryValuationSummary(
  userId: string,
  maxAgeSeconds = 30 * 60,
): Promise<InventoryValuationTotals | null> {
  try {
    const { data, error } = await supabase
      .from("inventory_valuation_summary")
      .select(
        "value,units,skus,available,reserved,inbound,unfulfilled,available_value,reserved_value,inbound_value,unfulfilled_value,low_stock,total_rows,rows_stale_24h,most_recent_sync,computed_at",
      )
      .eq("user_id", userId)
      .maybeSingle();
    if (error || !data) return null;
    const computedAt = data.computed_at ? new Date(data.computed_at).getTime() : 0;
    if (!computedAt || Date.now() - computedAt > maxAgeSeconds * 1000) return null;
    return {
      value: Number(data.value || 0),
      units: Number(data.units || 0),
      skus: Number(data.skus || 0),
      available: Number(data.available || 0),
      reserved: Number(data.reserved || 0),
      inbound: Number(data.inbound || 0),
      unfulfilled: Number(data.unfulfilled || 0),
      availableValue: Number(data.available_value || 0),
      reservedValue: Number(data.reserved_value || 0),
      inboundValue: Number(data.inbound_value || 0),
      unfulfilledValue: Number(data.unfulfilled_value || 0),
      lowStock: Number(data.low_stock || 0),
      totalRows: Number(data.total_rows || 0),
      rowsStale24h: Number(data.rows_stale_24h || 0),
      mostRecentSync: data.most_recent_sync ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Fire-and-forget request to the server writer. Used by the manual Refresh
 * button so the next poll sees a fresh row. Lock inside the edge fn
 * prevents concurrent recomputes when multiple tabs press refresh.
 */
export async function triggerInventoryValuationRefresh(): Promise<void> {
  try {
    await supabase.functions.invoke("refresh-inventory-valuation-summary", {
      body: { source: "manual" },
    });
  } catch {
    // ignore — UI falls back to live compute
  }
}

export async function getInventoryValuationTotals(
  userId: string,
  opts: { preferSummary?: boolean; maxAgeSeconds?: number } = {},
): Promise<InventoryValuationTotals> {
  const preferSummary = opts.preferSummary !== false;
  if (preferSummary) {
    const cached = await readInventoryValuationSummary(userId, opts.maxAgeSeconds);
    if (cached) return cached;
  }
  return getInventoryValuationTotalsLive(userId);
}

async function getInventoryValuationTotalsLive(userId: string): Promise<InventoryValuationTotals> {
  const [inventoryRows, listingRows, overridesByAsin] = await Promise.all([
    fetchAllKeyset<InventoryRow>(
      "inventory",
      "id,available,reserved,inbound,unfulfilled,cost,amount,units,unit_cost_manual,last_summaries_at,listing_status,asin,sku,created_at",
      userId,
    ),
    fetchAllKeyset<ListingRow>(
      "created_listings",
      "id,asin,sku,cost,amount,units,created_at,updated_at",
      userId,
    ),
    fetchAsinCostOverrides(userId),
  ]);

  // Build cost maps EXACTLY like SyncedInventory desktop:
  // ordered by created_at DESC; first-seen wins for SKU; for ASIN keep entry
  // unless current has units > 0.
  const costBySku = new Map<string, CostEntry>();
  const costByAsin = new Map<string, CostEntry>();
  for (const row of listingRows) {
    if (!row.asin) continue;
    const entry: CostEntry = {
      unitCost: getListingUnitCost({ cost: row.cost, amount: row.amount, units: row.units }),
      totalCost: getListingTotalCost({ cost: row.cost, amount: row.amount, units: row.units }),
      units: row.units !== null && row.units !== undefined ? Number(row.units) : null,
    };
    if (row.sku && !costBySku.has(row.sku)) costBySku.set(row.sku, entry);
    const existing = costByAsin.get(row.asin);
    if (!existing || existing.units === null || existing.units <= 0) {
      costByAsin.set(row.asin, entry);
    }
  }

  // Desktop visibleInventory filter: exclude NOT_IN_CATALOG / DELETED.
  // Desktop groups by ASIN+SKU; we mirror that since same row can exist twice.
  const grouped = new Map<string, InventoryRow & { _unitCost: number }>();
  for (const row of inventoryRows) {
    const status = String(row.listing_status || "").toUpperCase();
    if (status === "NOT_IN_CATALOG" || status === "DELETED") continue;

    // Resolve unit cost using the SAME precedence as SyncedInventory:
    //   manual override → item.cost (per-unit)
    //   else → costEntry.unitCost ?? item.cost (already per-unit) ?? compute
    const costEntry = costBySku.get(row.sku) ?? costByAsin.get(row.asin);
    const override = overridesByAsin.get(row.asin);
    let unitCost: number;
    if (override !== undefined) {
      unitCost = override;
    } else if (row.unit_cost_manual && row.cost !== null && row.cost !== undefined) {
      unitCost = Number(row.cost);
    } else {
      const fromEntry = costEntry?.unitCost;
      if (fromEntry !== null && fromEntry !== undefined) {
        unitCost = Number(fromEntry);
      } else if (row.cost !== null && row.cost !== undefined) {
        unitCost = Number(row.cost);
      } else {
        unitCost = getInventoryUnitCost({ cost: row.cost, amount: row.amount, units: row.units }) ?? 0;
      }
    }

    const key = `${row.asin}::${row.sku}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.available = (existing.available ?? 0) + (row.available ?? 0);
      existing.reserved = (existing.reserved ?? 0) + (row.reserved ?? 0);
      existing.inbound = (existing.inbound ?? 0) + (row.inbound ?? 0);
      existing.unfulfilled = (existing.unfulfilled ?? 0) + (row.unfulfilled ?? 0);
      // unit cost: keep first non-zero
      if (!existing._unitCost && unitCost) existing._unitCost = unitCost;
    } else {
      grouped.set(key, { ...row, _unitCost: unitCost });
    }
  }

  let available = 0, reserved = 0, inbound = 0, unfulfilled = 0;
  let availableValue = 0, reservedValue = 0, inboundValue = 0, unfulfilledValue = 0;
  let lowStock = 0, skus = 0, rowsStale24h = 0;
  let mostRecentSync: string | null = null;
  const staleCutoff = Date.now() - 24 * 3600 * 1000;

  for (const row of grouped.values()) {
    const av = Number(row.available || 0);
    const rs = Number(row.reserved || 0);
    const ib = Number(row.inbound || 0);
    const uf = Number(row.unfulfilled || 0);
    const unitCost = row._unitCost || 0;

    if (av + rs + ib + uf > 0) skus += 1;
    available += av;
    reserved += rs;
    inbound += ib;
    unfulfilled += uf;
    availableValue += av * unitCost;
    reservedValue += rs * unitCost;
    inboundValue += ib * unitCost;
    unfulfilledValue += uf * unitCost;
    if (av > 0 && av <= 3) lowStock += 1;
    if (row.last_summaries_at && (!mostRecentSync || row.last_summaries_at > mostRecentSync)) mostRecentSync = row.last_summaries_at;
    if (av + rs > 0 && (!row.last_summaries_at || new Date(row.last_summaries_at).getTime() < staleCutoff)) rowsStale24h += 1;
  }

  const value = availableValue + reservedValue + inboundValue + unfulfilledValue;
  return {
    value,
    units: available + reserved + inbound + unfulfilled,
    skus,
    available,
    reserved,
    inbound,
    unfulfilled,
    availableValue,
    reservedValue,
    inboundValue,
    unfulfilledValue,
    lowStock,
    totalRows: inventoryRows.length,
    rowsStale24h,
    mostRecentSync,
  };
}
