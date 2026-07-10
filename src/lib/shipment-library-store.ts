// Supabase-backed persistence for the Shipment Builder library.
// Drafts are stored per-user in `shipment_builder_drafts`, so counters and
// history survive across browsers, devices, refreshes, and cache clearing.

import { supabase } from "@/integrations/supabase/client";

// We keep the shape opaque here — the page owns the full draft type and just
// hands us a serialized snapshot. We persist it as `payload` JSONB.
export type ShipmentLibraryStatus = "draft" | "continued" | "synced" | "completed" | "archived";

export interface ShipmentLibraryRecordInput {
  draftId: string;
  shipmentName: string;
  note?: string;
  status: ShipmentLibraryStatus;
  step: number;
  creationMode: string;
  payload: Record<string, unknown>;
  inboundPlanId?: string | null;
  amazonShipmentId?: string | null;
  placementOptionId?: string | null;
  continuedToAmazonAt?: string | null;
  syncedAt?: string | null;
  completedAt?: string | null;
  archivedAt?: string | null;
  amazonOperationId?: string | null;
  amazonPlanStatus?: string | null;
}

export interface ShipmentLibraryRow {
  draft_id: string;
  shipment_name: string;
  note: string;
  status: ShipmentLibraryStatus;
  step: number;
  creation_mode: string;
  payload: Record<string, unknown>;
  inbound_plan_id: string | null;
  amazon_shipment_id: string | null;
  placement_option_id: string | null;
  continued_to_amazon_at: string | null;
  synced_at: string | null;
  completed_at: string | null;
  archived_at: string | null;
  amazon_operation_id: string | null;
  amazon_plan_status: string | null;
  created_at: string;
  updated_at: string;
}

const TABLE = "shipment_builder_drafts";

export async function fetchShipmentLibrary(userId: string): Promise<ShipmentLibraryRow[]> {
  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(200);

  if (error) {
    console.warn("[shipment-library-store] fetch failed:", error);
    return [];
  }

  return (data ?? []) as unknown as ShipmentLibraryRow[];
}

export async function upsertShipmentLibraryRecord(
  userId: string,
  record: ShipmentLibraryRecordInput,
): Promise<void> {
  const row = {
    user_id: userId,
    draft_id: record.draftId,
    shipment_name: record.shipmentName ?? "",
    note: record.note ?? "",
    status: record.status,
    step: record.step,
    creation_mode: record.creationMode,
    payload: record.payload ?? {},
    inbound_plan_id: record.inboundPlanId ?? null,
    amazon_shipment_id: record.amazonShipmentId ?? null,
    placement_option_id: record.placementOptionId ?? null,
    continued_to_amazon_at: record.continuedToAmazonAt ?? null,
    synced_at: record.syncedAt ?? null,
    completed_at: record.completedAt ?? null,
    archived_at: record.archivedAt ?? null,
    amazon_operation_id: record.amazonOperationId ?? null,
    amazon_plan_status: record.amazonPlanStatus ?? null,
  };

  const { error } = await supabase
    .from(TABLE)
    .upsert([row as never], { onConflict: "user_id,draft_id" });

  if (error) {
    console.warn("[shipment-library-store] upsert failed:", error);
  }
}

export async function deleteShipmentLibraryRecord(userId: string, draftId: string): Promise<void> {
  // Cascade: remove purchase allocations tied to this draft so the
  // Purchase vs Shipment Report doesn't show orphaned rows.
  const { error: allocErr } = await supabase
    .from("shipment_purchase_allocations")
    .delete()
    .eq("user_id", userId)
    .eq("draft_id", draftId);
  if (allocErr) {
    console.warn("[shipment-library-store] alloc cascade delete failed:", allocErr);
  }

  const { error } = await supabase
    .from(TABLE)
    .delete()
    .eq("user_id", userId)
    .eq("draft_id", draftId);

  if (error) {
    console.warn("[shipment-library-store] delete failed:", error);
  }
}
