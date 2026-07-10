/**
 * Frontend helper that fetches FEC refund rows for a given user / date range /
 * marketplace and returns canonical NET refund totals via the shared math
 * module. Used by PeriodStatsBlocks to eliminate the GROSS-vs-NET drift
 * documented in .lovable/architecture-audit.md §1.2.
 *
 * Date range is INCLUSIVE on both ends. Marketplace 'ALL' (or undefined)
 * pulls every marketplace; 'US' pulls US + NULL (legacy backfill compat,
 * matching LiveSales.tsx's same filter).
 */

import { supabase } from "@/integrations/supabase/client";
import { fetchAllPages } from "@/lib/sales/paginatedFetch";
import {
  computeNetRefundFromFecRows,
  type CanonicalRefundTotals,
} from "./refundMath";

export const REFUND_FEC_SELECT =
  "amazon_order_id, asin, marketplace, event_date, " +
  "refunds, promotional_rebate_refunds, shipping_credit_refunds, " +
  "shipping_chargeback_refund, gift_wrap_credit_refunds, referral_fees, " +
  "fba_fees, fba_customer_return_fees, restocking_fee, other_fees, " +
  "digital_services_fee, reversal_reimbursement";

export async function fetchCanonicalRefundsForRange(opts: {
  userId: string;
  startDate: string; // 'YYYY-MM-DD' inclusive
  endDate: string;   // 'YYYY-MM-DD' inclusive
  marketplace?: string | string[] | null;
  label?: string;
}): Promise<CanonicalRefundTotals> {
  const { userId, startDate, endDate, marketplace, label } = opts;
  const rows = await fetchAllPages<any>(
    () => {
      let q = supabase
        .from("financial_events_cache")
        .select(REFUND_FEC_SELECT)
        .eq("user_id", userId)
        .eq("event_type", "refund")
        .gte("event_date", startDate)
        .lte("event_date", endDate)
        .order("event_date", { ascending: true });
      if (marketplace && marketplace !== "ALL") {
        if (Array.isArray(marketplace)) {
          if (marketplace.length > 0 && !marketplace.includes("ALL")) {
            q = q.in("marketplace", marketplace);
          }
        } else if (marketplace === "US") {
          q = q.or("marketplace.eq.US,marketplace.is.null");
        } else {
          q = q.eq("marketplace", marketplace);
        }
      }
      return q;
    },
    { label: label || `canonical refunds ${startDate}..${endDate}` },
  );
  return computeNetRefundFromFecRows(rows as any[], "full");
}
