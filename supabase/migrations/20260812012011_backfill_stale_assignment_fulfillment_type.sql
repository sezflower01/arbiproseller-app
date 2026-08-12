-- Backfill repricer_assignments.fulfillment_type for rows that were frozen wrong
-- at creation (auto-assign-bulk never sets it; fetch-live-orders/sync-sales-orders
-- only set it on insert, never on update) and never self-corrected since.
--
-- Uses the same hard-evidence classifier already proven in
-- AssignmentsTable.tsx's fulfillment_type display logic and mirrored in
-- repricer-ai-evaluate's ground-truth resolution: FNSKU presence, FBA
-- reserved+inbound quantity, or inventory sync source are authoritative
-- over whatever was guessed at onboarding.

with evidence as (
  select
    ra.id as assignment_id,
    ra.fulfillment_type as stored_fulfillment_type,
    case
      when (inv.fnsku is not null and length(trim(inv.fnsku)) > 0)
        or (coalesce(inv.reserved, 0) + coalesce(inv.inbound, 0)) > 0
        or lower(coalesce(inv.source, '')) = 'amazon_sync'
        or (lower(coalesce(inv.source, '')) like '%fba%' and lower(coalesce(inv.source, '')) not like '%fbm%')
        then 'FBA'
      when lower(coalesce(inv.source, '')) = 'amazon_sync_fbm'
        or (lower(coalesce(inv.source, '')) like '%fbm%' and lower(coalesce(inv.source, '')) not like '%fba%')
        then 'FBM'
      else null
    end as evidence_fulfillment_type
  from repricer_assignments ra
  join inventory inv
    on inv.user_id = ra.user_id
   and inv.sku = ra.sku
  where ra.fulfillment_type is not null
)
update repricer_assignments ra
set fulfillment_type = evidence.evidence_fulfillment_type,
    updated_at = now()
from evidence
where ra.id = evidence.assignment_id
  and evidence.evidence_fulfillment_type is not null
  and evidence.evidence_fulfillment_type != evidence.stored_fulfillment_type;
