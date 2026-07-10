import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Loader2, Calculator, TrendingUp, RefreshCw, AlertTriangle } from "lucide-react";

interface ActualRoiCalculatorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  asin: string;
  productTitle: string;
  imageUrl: string | null;
  currentPrice: number | null;
  unitCost: number | null;
}

interface ActualRoiData {
  totalUnits: number;
  totalSales: number;
  totalFees: number;
  totalRefunds: number;
  refundUnits: number;
  totalCogs: number;
  netRevenue: number;
  netProfit: number;
  actualRoi: number;
  profitMargin: number;
  avgSellPrice: number;
  avgFeesPerUnit: number;
  refundRate: number;
}

export function ActualRoiCalculatorDialog({
  open,
  onOpenChange,
  asin,
  productTitle,
  imageUrl,
  currentPrice,
  unitCost,
}: ActualRoiCalculatorDialogProps) {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<ActualRoiData | null>(null);

  const fetchActualRoi = async () => {
    setLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");

      // Fetch actual sales data for this ASIN (excluding -REFUND records for sales counts)
      const { data: salesData, error: salesError } = await supabase
        .from('sales_orders')
        .select('order_id, quantity, sold_price, total_fees, refund_amount, refund_quantity, unit_cost, total_sale_amount')
        .eq('user_id', session.user.id)
        .eq('asin', asin);

      if (salesError) throw salesError;

      if (!salesData || salesData.length === 0) {
        toast.error("No sales data found for this ASIN");
        setData(null);
        setLoading(false);
        return;
      }

      // Separate sales orders from refund records
      // Refund records have "-REFUND" in order_id and track refunds separately
      const actualSales = salesData.filter(o => !o.order_id?.includes('-REFUND'));
      const refundRecords = salesData.filter(o => o.order_id?.includes('-REFUND'));

      // Calculate metrics from actual sales (not refund records)
      let totalUnits = 0;
      let totalSales = 0;
      let totalFees = 0;
      let totalCogs = 0;

      for (const order of actualSales) {
        const qty = order.quantity || 0;
        const cost = order.unit_cost || unitCost || 0;
        
        totalUnits += qty;
        totalSales += Math.max(0, order.total_sale_amount || 0); // Only positive sales
        totalFees += Math.abs(order.total_fees || 0);
        totalCogs += cost * qty;
      }

      // Calculate refunds from dedicated -REFUND records
      let totalRefunds = 0;
      let refundUnits = 0;
      
      for (const refund of refundRecords) {
        totalRefunds += Math.abs(refund.refund_amount || 0);
        refundUnits += Math.abs(refund.refund_quantity || refund.quantity || 0);
      }
      
      // Also add any refund data from original orders (legacy data)
      for (const order of actualSales) {
        if (order.refund_amount && order.refund_amount > 0) {
          totalRefunds += order.refund_amount;
          refundUnits += order.refund_quantity || 0;
        }
      }

      // Net revenue = Sales - Refunds
      const netRevenue = totalSales - totalRefunds;
      
      // Net Profit = Net Revenue - Total Fees - COGS
      const netProfit = netRevenue - totalFees - totalCogs;
      
      // Actual ROI = (Net Profit / Total COGS) * 100
      const actualRoi = totalCogs > 0 ? (netProfit / totalCogs) * 100 : 0;
      
      // Profit Margin = (Net Profit / Net Revenue) * 100
      const profitMargin = netRevenue > 0 ? (netProfit / netRevenue) * 100 : 0;
      
      // Average metrics
      const avgSellPrice = totalUnits > 0 ? totalSales / totalUnits : 0;
      const avgFeesPerUnit = totalUnits > 0 ? totalFees / totalUnits : 0;
      
      // Refund rate
      const refundRate = totalUnits > 0 ? (refundUnits / totalUnits) * 100 : 0;

      setData({
        totalUnits,
        totalSales,
        totalFees,
        totalRefunds,
        refundUnits,
        totalCogs,
        netRevenue,
        netProfit,
        actualRoi,
        profitMargin,
        avgSellPrice,
        avgFeesPerUnit,
        refundRate,
      });

      toast.success("Actual ROI calculated from sales data");
    } catch (error: any) {
      console.error("Error fetching actual ROI:", error);
      toast.error("Failed to fetch sales data");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open && asin) {
      fetchActualRoi();
    }
  }, [open, asin]);

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      setData(null);
    }
    onOpenChange(newOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto bg-gradient-to-br from-emerald-50 via-white to-teal-50 dark:from-slate-900 dark:via-slate-800 dark:to-emerald-950 border-2 border-emerald-200 dark:border-emerald-700 shadow-2xl z-50">
        <DialogHeader className="border-b border-emerald-200 dark:border-emerald-700 pb-2">
          <DialogTitle className="flex items-center gap-2 text-base text-emerald-900 dark:text-emerald-100">
            <TrendingUp className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
            Actual ROI Calculator
          </DialogTitle>
          <DialogDescription className="text-xs text-slate-600 dark:text-slate-300">
            ROI based on real sales, fees, and refunds for this ASIN
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          {/* Product Info */}
          <div className="flex gap-2 p-2 border border-emerald-200 dark:border-emerald-700 rounded-lg bg-white dark:bg-slate-800 shadow-sm">
            {imageUrl && (
              <img
                src={imageUrl}
                alt={productTitle}
                className="w-12 h-12 object-contain border border-emerald-300 dark:border-emerald-600 rounded bg-white p-0.5"
              />
            )}
            <div className="flex-1 space-y-0.5">
              <p className="font-semibold text-xs line-clamp-2 text-slate-900 dark:text-slate-100">{productTitle}</p>
              <p className="text-[10px] text-emerald-600 dark:text-emerald-400 font-medium">ASIN: {asin}</p>
              {currentPrice !== null && currentPrice > 0 && (
                <p className="text-xs font-bold text-green-700 dark:text-green-400">
                  Current Price: ${currentPrice.toFixed(2)}
                </p>
              )}
            </div>
          </div>

          {/* Loading State */}
          {loading && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-emerald-600" />
              <span className="ml-2 text-sm text-slate-600 dark:text-slate-300">Loading sales data...</span>
            </div>
          )}

          {/* No Data State */}
          {!loading && !data && (
            <div className="p-4 border border-amber-200 dark:border-amber-700 rounded-lg bg-amber-50 dark:bg-amber-900/30 text-center">
              <AlertTriangle className="h-8 w-8 text-amber-500 mx-auto mb-2" />
              <p className="text-sm text-amber-800 dark:text-amber-200">No sales data available for this ASIN</p>
              <Button
                onClick={fetchActualRoi}
                variant="outline"
                size="sm"
                className="mt-2"
              >
                <RefreshCw className="h-3 w-3 mr-1" />
                Retry
              </Button>
            </div>
          )}

          {/* Calculation Results */}
          {!loading && data && (
            <div className="p-3 border border-emerald-200 dark:border-emerald-800 rounded-lg bg-gradient-to-br from-white via-emerald-50 to-teal-50 dark:from-slate-800 dark:via-slate-700 dark:to-emerald-950 shadow-md space-y-2">
              <h4 className="font-bold text-sm mb-2 text-emerald-900 dark:text-emerald-100 border-b border-emerald-300 dark:border-emerald-700 pb-1">📊 Actual Performance</h4>
              
              <div className="grid grid-cols-2 gap-2">
                {/* Sales Summary */}
                <div className="p-2 bg-gradient-to-br from-blue-100 to-blue-50 dark:from-blue-900 dark:to-blue-800 rounded border border-blue-300 dark:border-blue-600">
                  <p className="text-[10px] font-semibold text-blue-700 dark:text-blue-300 mb-0.5">Total Units Sold</p>
                  <p className="text-sm font-bold text-blue-900 dark:text-blue-100">{data.totalUnits}</p>
                </div>
                <div className="p-2 bg-gradient-to-br from-green-100 to-green-50 dark:from-green-900 dark:to-green-800 rounded border border-green-300 dark:border-green-600">
                  <p className="text-[10px] font-semibold text-green-700 dark:text-green-300 mb-0.5">Total Sales</p>
                  <p className="text-sm font-bold text-green-900 dark:text-green-100">${data.totalSales.toFixed(2)}</p>
                </div>

                {/* Fees & Refunds */}
                <div className="p-2 bg-gradient-to-br from-orange-100 to-orange-50 dark:from-orange-900 dark:to-orange-800 rounded border border-orange-300 dark:border-orange-600">
                  <p className="text-[10px] font-semibold text-orange-700 dark:text-orange-300 mb-0.5">Total Amazon Fees</p>
                  <p className="text-sm font-bold text-orange-900 dark:text-orange-100">-${data.totalFees.toFixed(2)}</p>
                </div>
                <div className="p-2 bg-gradient-to-br from-red-100 to-red-50 dark:from-red-900 dark:to-red-800 rounded border border-red-300 dark:border-red-600">
                  <p className="text-[10px] font-semibold text-red-700 dark:text-red-300 mb-0.5">Refunds ({data.refundUnits} units)</p>
                  <p className="text-sm font-bold text-red-900 dark:text-red-100">-${data.totalRefunds.toFixed(2)}</p>
                </div>

                {/* COGS & Net Revenue */}
                <div className="p-2 bg-gradient-to-br from-purple-100 to-purple-50 dark:from-purple-900 dark:to-purple-800 rounded border border-purple-300 dark:border-purple-600">
                  <p className="text-[10px] font-semibold text-purple-700 dark:text-purple-300 mb-0.5">Total COGS</p>
                  <p className="text-sm font-bold text-purple-900 dark:text-purple-100">-${data.totalCogs.toFixed(2)}</p>
                </div>
                <div className="p-2 bg-gradient-to-br from-teal-100 to-teal-50 dark:from-teal-900 dark:to-teal-800 rounded border border-teal-300 dark:border-teal-600">
                  <p className="text-[10px] font-semibold text-teal-700 dark:text-teal-300 mb-0.5">Net Revenue</p>
                  <p className="text-sm font-bold text-teal-900 dark:text-teal-100">${data.netRevenue.toFixed(2)}</p>
                </div>

                {/* Averages */}
                <div className="p-2 bg-gradient-to-br from-slate-100 to-slate-50 dark:from-slate-700 dark:to-slate-600 rounded border border-slate-300 dark:border-slate-500">
                  <p className="text-[10px] font-semibold text-slate-700 dark:text-slate-300 mb-0.5">Avg Sell Price</p>
                  <p className="text-sm font-bold text-slate-900 dark:text-slate-100">${data.avgSellPrice.toFixed(2)}</p>
                </div>
                <div className="p-2 bg-gradient-to-br from-amber-100 to-amber-50 dark:from-amber-900 dark:to-amber-800 rounded border border-amber-300 dark:border-amber-600">
                  <p className="text-[10px] font-semibold text-amber-700 dark:text-amber-300 mb-0.5">Refund Rate</p>
                  <p className={`text-sm font-bold ${data.refundRate > 10 ? 'text-red-700 dark:text-red-400' : 'text-amber-900 dark:text-amber-100'}`}>
                    {data.refundRate.toFixed(1)}%
                  </p>
                </div>

                {/* Net Profit */}
                <div className="col-span-2 border-t border-emerald-300 dark:border-emerald-600 pt-2 mt-1">
                  <div className="p-2 bg-gradient-to-br from-indigo-100 to-indigo-50 dark:from-indigo-900 dark:to-indigo-800 rounded border border-indigo-400 dark:border-indigo-600">
                    <p className="text-[10px] font-semibold text-indigo-700 dark:text-indigo-300 mb-0.5">Net Profit</p>
                    <p className={`text-base font-bold ${data.netProfit >= 0 ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'}`}>
                      ${data.netProfit.toFixed(2)}
                    </p>
                  </div>
                </div>

                {/* ROI & Margin */}
                <div className="col-span-2 border-t border-emerald-300 dark:border-emerald-700 pt-2 mt-1">
                  <div className="grid grid-cols-2 gap-2">
                    <div className="p-3 bg-gradient-to-br from-emerald-200 to-emerald-100 dark:from-emerald-800 dark:to-emerald-700 rounded-lg border border-emerald-400 dark:border-emerald-600">
                      <p className="text-[10px] font-bold text-emerald-800 dark:text-emerald-200 mb-1">📈 Actual ROI</p>
                      <p className={`text-xl font-black ${data.actualRoi >= 0 ? 'text-green-700 dark:text-green-300' : 'text-red-700 dark:text-red-300'}`}>
                        {data.actualRoi.toFixed(2)}%
                      </p>
                    </div>
                    <div className="p-3 bg-gradient-to-br from-cyan-200 to-cyan-100 dark:from-cyan-800 dark:to-cyan-700 rounded-lg border border-cyan-400 dark:border-cyan-600">
                      <p className="text-[10px] font-bold text-cyan-800 dark:text-cyan-200 mb-1">💹 Profit Margin</p>
                      <p className={`text-xl font-black ${data.profitMargin >= 0 ? 'text-green-700 dark:text-green-300' : 'text-red-700 dark:text-red-300'}`}>
                        {data.profitMargin.toFixed(2)}%
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              <Button 
                onClick={fetchActualRoi} 
                disabled={loading}
                variant="outline"
                className="w-full mt-2 text-xs border border-emerald-400 dark:border-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-900 font-semibold py-2"
              >
                <RefreshCw className="h-3 w-3 mr-1" />
                Refresh Data
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
