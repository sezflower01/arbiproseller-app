CREATE OR REPLACE FUNCTION public.fn_grant_default_module_access()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  m text;
  a text;
  modules text[] := ARRAY[
    'repricer','inventory','reports','supplier_discovery','product_library',
    'personalhour','fba_builder','profit_loss','buy_again','still_thinking',
    'mobile_live_sales','mobile_inventory_valuation','upc_scanner','scan_history',
    'settings'
  ];
  actions text[] := ARRAY['view','run','edit'];
BEGIN
  IF EXISTS (SELECT 1 FROM public.user_module_access WHERE user_id = NEW.id) THEN
    RETURN NEW;
  END IF;

  IF EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = NEW.id AND role = 'admin') THEN
    RETURN NEW;
  END IF;

  FOREACH m IN ARRAY modules LOOP
    FOREACH a IN ARRAY actions LOOP
      INSERT INTO public.user_module_access (user_id, module, action)
      VALUES (NEW.id, m::app_module, a::app_action)
      ON CONFLICT DO NOTHING;
    END LOOP;
  END LOOP;

  RETURN NEW;
END;
$$;