import LiveSales from "./LiveSales";

/**
 * Sales Report = Live Sales (exact same totals/UI/source). All breakdown
 * sections (Refunds, Cancelled Orders, Fees & Credits) now live INSIDE
 * LiveSales so both /tools/live-sales and /tools/sales show identical data.
 */
export default function Sales() {
  return <LiveSales title="Sales Report" />;
}
