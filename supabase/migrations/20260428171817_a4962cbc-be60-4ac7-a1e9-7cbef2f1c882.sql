INSERT INTO public.fba_shipments
  (user_id, shipment_id, shipment_name, destination_fulfillment_center_id, shipment_status, created_at, updated_at)
VALUES
  ('020dd71f-78ce-4bc2-9117-dc997c533ab9', 'FBA19CDXYGYL', 'FBA STA (04/28/2026 16:34)-CLT2', 'CLT2', 'READY_TO_SHIP', now(), now()),
  ('020dd71f-78ce-4bc2-9117-dc997c533ab9', 'FBA19CDY06Q1', 'FBA STA (04/28/2026 16:34)-MDW2', 'MDW2', 'READY_TO_SHIP', now(), now()),
  ('020dd71f-78ce-4bc2-9117-dc997c533ab9', 'FBA19CDZ516V', 'FBA STA (04/28/2026 16:34)-ABE8', 'ABE8', 'READY_TO_SHIP', now(), now()),
  ('020dd71f-78ce-4bc2-9117-dc997c533ab9', 'FBA19CDYQ1JZ', 'FBA STA (04/28/2026 16:34)-SMF3', 'SMF3', 'READY_TO_SHIP', now(), now()),
  ('020dd71f-78ce-4bc2-9117-dc997c533ab9', 'FBA19CDXRXV3', 'FBA STA (04/28/2026 16:34)-FTW1', 'FTW1', 'READY_TO_SHIP', now(), now())
ON CONFLICT (user_id, shipment_id) DO NOTHING;

UPDATE public.shipment_builder_drafts
SET amazon_shipment_id = 'FBA19CDXYGYL',
    status = 'synced',
    synced_at = now(),
    amazon_plan_status = 'CONFIRMED',
    updated_at = now()
WHERE draft_id = '469daffc-3d78-48b9-ab6a-bb8c468a85d1'
  AND user_id = '020dd71f-78ce-4bc2-9117-dc997c533ab9';