INSERT INTO public.inventory_dispositions
  (user_id, disposition_date, disposition_type, status, source, asin, msku, title, sellable_qty, unsellable_qty, unit_cost, recovery_amount)
VALUES
  ('020dd71f-78ce-4bc2-9117-dc997c533ab9', CURRENT_DATE, 'removal', 'accepted',       'manual', 'TESTACC001', 'TEST-ACC-001', 'TEST P&L Accepted',       0, 2, 10, 3),
  ('020dd71f-78ce-4bc2-9117-dc997c533ab9', CURRENT_DATE, 'removal', 'pending_review', 'manual', 'TESTPND001', 'TEST-PND-001', 'TEST P&L Pending Review', 0, 5, 20, 0),
  ('020dd71f-78ce-4bc2-9117-dc997c533ab9', CURRENT_DATE, 'removal', 'ignored',        'manual', 'TESTIGN001', 'TEST-IGN-001', 'TEST P&L Ignored',        0, 5, 20, 0);