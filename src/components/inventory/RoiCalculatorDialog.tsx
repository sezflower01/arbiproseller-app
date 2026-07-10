import { useState } from "react";
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
import { Loader2, Calculator } from "lucide-react";

interface RoiCalculatorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  asin: string;
  unitCost: number | null;
  productTitle: string;
  imageUrl: string | null;
  currentPrice: number | null;
}

interface CalculationData {
  referralFee: number;
  fbaFee: number;
  variableClosingFee: number;
  otherFees: number;
  totalFees: number;
  profit: number;
  roi: number;
  margin: number;
}

export function RoiCalculatorDialog({
  open,
  onOpenChange,
  asin,
  unitCost,
  productTitle,
  imageUrl,
  currentPrice,
}: RoiCalculatorDialogProps) {
  const [loading, setLoading] = useState(false);
  const [calculation, setCalculation] = useState<CalculationData | null>(null);

  const calculateROI = async () => {
    if (!unitCost || unitCost <= 0) {
      toast.error("Unit cost is required to calculate ROI");
      return;
    }

    setLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");

      const { data, error } = await supabase.functions.invoke("calculate-roi", {
        body: { asin, cost: unitCost },
        headers: { Authorization: `Bearer ${session.access_token}` }
      });

      if (error) {
        const msg = error.message || "";
        if (msg.includes("QUOTA_EXCEEDED") || msg.includes("429")) {
          toast.error("Amazon SP-API quota exceeded. Please try again later.");
        } else {
          toast.error("Failed to calculate ROI: " + msg);
        }
        return;
      }

      if (data?.calculation) {
        setCalculation(data.calculation);
        toast.success("ROI calculated successfully");
      }
    } catch (error: any) {
      console.error("Error calculating ROI:", error);
      toast.error("Failed to calculate ROI");
    } finally {
      setLoading(false);
    }
  };

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      // Reset calculation when closing
      setCalculation(null);
    }
    onOpenChange(newOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto bg-gradient-to-br from-blue-50 via-white to-purple-50 dark:from-slate-900 dark:via-slate-800 dark:to-indigo-950 border-2 border-blue-200 dark:border-indigo-700 shadow-2xl z-50">
        <DialogHeader className="border-b border-blue-200 dark:border-indigo-700 pb-2">
          <DialogTitle className="flex items-center gap-2 text-base text-blue-900 dark:text-blue-100">
            <Calculator className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            ROI Calculator
          </DialogTitle>
          <DialogDescription className="text-xs text-slate-600 dark:text-slate-300">
            Calculate return on investment with detailed fee breakdown
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          {/* Product Info */}
          <div className="flex gap-2 p-2 border border-blue-200 dark:border-indigo-700 rounded-lg bg-white dark:bg-slate-800 shadow-sm">
            {imageUrl && (
              <img
                src={imageUrl}
                alt={productTitle}
                className="w-12 h-12 object-contain border border-blue-300 dark:border-indigo-600 rounded bg-white p-0.5"
              />
            )}
            <div className="flex-1 space-y-0.5">
              <p className="font-semibold text-xs line-clamp-2 text-slate-900 dark:text-slate-100">{productTitle}</p>
              <p className="text-[10px] text-blue-600 dark:text-blue-400 font-medium">ASIN: {asin}</p>
              {currentPrice !== null && currentPrice > 0 && (
                <p className="text-xs font-bold text-green-700 dark:text-green-400">
                  Price: ${currentPrice.toFixed(2)}
                </p>
              )}
            </div>
          </div>

          {/* Calculate Button */}
          {!calculation && (
            <Button 
              onClick={calculateROI} 
              disabled={loading || !unitCost}
              className="w-full bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 text-white font-semibold py-3 text-sm shadow-lg"
            >
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                  Calculating...
                </>
              ) : (
                <>
                  <Calculator className="mr-2 h-3 w-3" />
                  Calculate ROI
                </>
              )}
            </Button>
          )}

          {/* Calculation Results */}
          {calculation && (
            <div className="p-3 border border-green-200 dark:border-green-800 rounded-lg bg-gradient-to-br from-green-50 via-white to-emerald-50 dark:from-slate-800 dark:via-slate-700 dark:to-emerald-950 shadow-md space-y-2">
              <h4 className="font-bold text-sm mb-2 text-green-900 dark:text-green-100 border-b border-green-300 dark:border-green-700 pb-1">💰 Results</h4>
              
              <div className="grid grid-cols-2 gap-2">
                <div className="p-2 bg-gradient-to-br from-blue-100 to-blue-50 dark:from-blue-900 dark:to-blue-800 rounded border border-blue-300 dark:border-blue-600">
                  <p className="text-[10px] font-semibold text-blue-700 dark:text-blue-300 mb-0.5">Amazon Price</p>
                  <p className="text-sm font-bold text-blue-900 dark:text-blue-100">
                    ${currentPrice?.toFixed(2) || '0.00'}
                  </p>
                </div>
                <div className="p-2 bg-gradient-to-br from-purple-100 to-purple-50 dark:from-purple-900 dark:to-purple-800 rounded border border-purple-300 dark:border-purple-600">
                  <p className="text-[10px] font-semibold text-purple-700 dark:text-purple-300 mb-0.5">Your Cost</p>
                  <p className="text-sm font-bold text-purple-900 dark:text-purple-100">${unitCost?.toFixed(2) || '0.00'}</p>
                </div>
                <div className="p-2 bg-gradient-to-br from-orange-100 to-orange-50 dark:from-orange-900 dark:to-orange-800 rounded border border-orange-300 dark:border-orange-600">
                  <p className="text-[10px] font-semibold text-orange-700 dark:text-orange-300 mb-0.5">Referral Fee</p>
                  <p className="text-sm font-bold text-orange-900 dark:text-orange-100">${calculation.referralFee.toFixed(2)}</p>
                </div>
                <div className="p-2 bg-gradient-to-br from-red-100 to-red-50 dark:from-red-900 dark:to-red-800 rounded border border-red-300 dark:border-red-600">
                  <p className="text-[10px] font-semibold text-red-700 dark:text-red-300 mb-0.5">FBA Fee</p>
                  <p className="text-sm font-bold text-red-900 dark:text-red-100">${calculation.fbaFee.toFixed(2)}</p>
                </div>
                <div className="p-2 bg-gradient-to-br from-amber-100 to-amber-50 dark:from-amber-900 dark:to-amber-800 rounded border border-amber-300 dark:border-amber-600">
                  <p className="text-[10px] font-semibold text-amber-700 dark:text-amber-300 mb-0.5">Closing Fee</p>
                  <p className="text-sm font-bold text-amber-900 dark:text-amber-100">${calculation.variableClosingFee.toFixed(2)}</p>
                </div>
                <div className="p-2 bg-gradient-to-br from-slate-100 to-slate-50 dark:from-slate-700 dark:to-slate-600 rounded border border-slate-300 dark:border-slate-500">
                  <p className="text-[10px] font-semibold text-slate-700 dark:text-slate-300 mb-0.5">Other Fees</p>
                  <p className="text-sm font-bold text-slate-900 dark:text-slate-100">${calculation.otherFees.toFixed(2)}</p>
                </div>
                <div className="col-span-2 border-t border-slate-300 dark:border-slate-600 pt-2 mt-1">
                  <div className="p-2 bg-gradient-to-br from-indigo-100 to-indigo-50 dark:from-indigo-900 dark:to-indigo-800 rounded border border-indigo-400 dark:border-indigo-600">
                    <p className="text-[10px] font-semibold text-indigo-700 dark:text-indigo-300 mb-0.5">Total Fees</p>
                    <p className="text-base font-bold text-indigo-900 dark:text-indigo-100">${calculation.totalFees.toFixed(2)}</p>
                  </div>
                </div>
                <div className="p-2 bg-gradient-to-br from-teal-100 to-teal-50 dark:from-teal-900 dark:to-teal-800 rounded border border-teal-300 dark:border-teal-600">
                  <p className="text-[10px] font-semibold text-teal-700 dark:text-teal-300 mb-0.5">Net Profit</p>
                  <p className={`text-sm font-bold ${calculation.profit >= 0 ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'}`}>
                    ${calculation.profit.toFixed(2)}
                  </p>
                </div>
                <div className="col-span-2 border-t border-emerald-300 dark:border-emerald-700 pt-2 mt-1">
                  <div className="grid grid-cols-2 gap-2">
                    <div className="p-3 bg-gradient-to-br from-emerald-200 to-emerald-100 dark:from-emerald-800 dark:to-emerald-700 rounded-lg border border-emerald-400 dark:border-emerald-600">
                      <p className="text-[10px] font-bold text-emerald-800 dark:text-emerald-200 mb-1">📈 ROI</p>
                      <p className={`text-xl font-black ${calculation.roi >= 0 ? 'text-green-700 dark:text-green-300' : 'text-red-700 dark:text-red-300'}`}>
                        {calculation.roi.toFixed(2)}%
                      </p>
                    </div>
                    <div className="p-3 bg-gradient-to-br from-cyan-200 to-cyan-100 dark:from-cyan-800 dark:to-cyan-700 rounded-lg border border-cyan-400 dark:border-cyan-600">
                      <p className="text-[10px] font-bold text-cyan-800 dark:text-cyan-200 mb-1">💹 Margin</p>
                      <p className={`text-xl font-black ${calculation.margin >= 0 ? 'text-green-700 dark:text-green-300' : 'text-red-700 dark:text-red-300'}`}>
                        {calculation.margin.toFixed(2)}%
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              <Button 
                onClick={calculateROI} 
                disabled={loading}
                variant="outline"
                className="w-full mt-2 text-xs border border-blue-400 dark:border-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900 font-semibold py-2"
              >
                Recalculate
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
