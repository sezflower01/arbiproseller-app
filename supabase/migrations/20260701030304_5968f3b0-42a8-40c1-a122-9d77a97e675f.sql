
DROP TRIGGER IF EXISTS sales_orders_customer_profile_aiud ON public.sales_orders;

CREATE TRIGGER sales_orders_customer_profile_aiud
  AFTER INSERT OR UPDATE OF
    customer_key, buyer_email, buyer_name, buyer_id,
    quantity, total_sale_amount, refund_amount, is_replacement, asin, order_date
  OR DELETE
  ON public.sales_orders
  FOR EACH ROW EXECUTE FUNCTION public.sales_orders_customer_profile_refresh_trigger();
