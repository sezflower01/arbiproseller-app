import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ProductLabel } from "./ProductLabel";
import { Printer, Monitor, Loader2 } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { MacBrowserPrintTips } from "./MacBrowserPrintTips";

type LabelSizeId = "2x1" | "2.25x1.25" | "3x1";

interface LabelData {
  asin: string;
  fnsku?: string | null;
  condition?: string | null;
  title: string;
}

interface SimplePrintDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  labels: LabelData[];
}

// Amazon FNSKU label sizes
const LABEL_SIZES: { id: LabelSizeId; name: string; width: number; height: number }[] = [
  { id: "2x1", name: '2" × 1"', width: 2, height: 1 },
  { id: "2.25x1.25", name: '2.25" × 1.25"', width: 2.25, height: 1.25 },
  { id: "3x1", name: '3" × 1"', width: 3, height: 1 },
];

const CLIENT_URLS = ["http://localhost:7777", "http://127.0.0.1:7777"];
const isPrintableFnsku = (fnsku?: string | null, asin?: string | null) => {
  const code = (fnsku || "").trim().toUpperCase();
  return /^X[A-Z0-9]{9}$/.test(code) && code !== (asin || "").trim().toUpperCase();
};

export const SimplePrintDialog = ({ open, onOpenChange, labels }: SimplePrintDialogProps) => {
  const { toast } = useToast();
  const [selectedSize, setSelectedSize] = useState<LabelSizeId>("2x1");
  const [isSendingToClient, setIsSendingToClient] = useState(false);
  
  const currentSize = LABEL_SIZES.find(s => s.id === selectedSize) || LABEL_SIZES[0];
  
  // Direct Thermal Print - sends to Windows client on localhost:7777
  const handleDirectThermalPrint = async () => {
    if (labels.some((label) => !isPrintableFnsku(label.fnsku, label.asin))) {
      toast({
        title: "FNSKU required",
        description: "Printing is blocked because one or more labels do not have a valid X00 FNSKU.",
        variant: "destructive",
      });
      return;
    }
    setIsSendingToClient(true);
    try {
      const payload = {
        sizeId: selectedSize,
        labels: labels.map(l => ({
          asin: l.asin,
          fnsku: (l.fnsku || "").trim().toUpperCase(),
          condition: l.condition || "NEW",
          title: l.title,
        })),
      };

      console.log("[DIRECT_PRINT] Sending to local print client:", payload);

      let response: Response | null = null;
      let lastError: unknown = null;
      for (const baseUrl of CLIENT_URLS) {
        try {
          response = await fetch(`${baseUrl}/print-labels`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(10000),
          });
          break;
        } catch (error) {
          lastError = error;
        }
      }

      if (!response) throw lastError || new Error("Print client did not respond");

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Print client error: ${response.status} - ${errorText}`);
      }

      const result = await response.json();
      console.log("[DIRECT_PRINT] Success:", result);

      toast({
        title: "Labels sent to printer",
        description: `${labels.length} label(s) sent to thermal printer`,
      });

      onOpenChange(false);
    } catch (error: any) {
      console.error("[DIRECT_PRINT] Error:", error);
      
      if (error.message.includes("Failed to fetch") || error.message.includes("NetworkError")) {
        toast({
          title: "Print Client Not Running",
          description: "The ArbiProSeller Print Client is not running on localhost:7777. Please start it or use Browser Print instead.",
          variant: "destructive",
        });
      } else {
        toast({
          title: "Print Error",
          description: error.message || "Failed to send labels to printer",
          variant: "destructive",
        });
      }
    } finally {
      setIsSendingToClient(false);
    }
  };

  // Browser Print - uses native print dialog
  const handleBrowserPrint = () => {
    if (labels.some((label) => !isPrintableFnsku(label.fnsku, label.asin))) {
      toast({
        title: "FNSKU required",
        description: "Printing is blocked because one or more labels do not have a valid X00 FNSKU.",
        variant: "destructive",
      });
      return;
    }
    window.print();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[80vh] overflow-y-auto bg-white print:max-w-none print:max-h-none print:overflow-visible print:border-0 print:shadow-none">
        <style>{`
          @media print {
            @page {
              size: ${currentSize.width}in ${currentSize.height}in;
              margin: 0;
            }
            html, body {
              margin: 0;
              padding: 0;
              background: white;
              width: ${currentSize.width}in;
              height: ${currentSize.height}in;
            }
            * {
              border: none !important;
              box-shadow: none !important;
              outline: none !important;
            }
            body * {
              visibility: hidden;
            }
            .print-label, .print-label * {
              visibility: visible;
            }
            .print-label {
              position: absolute;
              left: 0;
              top: 0;
              width: ${currentSize.width}in !important;
              height: ${currentSize.height}in !important;
              page-break-after: always;
            }
          }
        `}</style>
        
        <DialogHeader className="print:hidden">
          <DialogTitle>Print Labels</DialogTitle>
          
          <div className="space-y-4 pt-4">
            {/* Label Size Selector */}
            <div className="flex items-center gap-3">
              <label className="text-sm font-medium">Label Size:</label>
              <Select value={selectedSize} onValueChange={(value: LabelSizeId) => setSelectedSize(value)}>
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder="Select size" />
                </SelectTrigger>
                <SelectContent>
                  {LABEL_SIZES.map((size) => (
                    <SelectItem key={size.id} value={size.id}>
                      {size.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            
            <p className="text-sm text-muted-foreground">
              Ready to print {labels.length} {labels.length === 1 ? "label" : "labels"} ({currentSize.name} thermal labels)
            </p>

            {/* Print Method Buttons */}
            <div className="space-y-2">
              {/* Primary: Direct Thermal Print */}
              <Button 
                onClick={handleDirectThermalPrint} 
                disabled={isSendingToClient}
                className="w-full bg-green-600 hover:bg-green-700"
              >
                {isSendingToClient ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Sending to Printer...
                  </>
                ) : (
                  <>
                    <Printer className="w-4 h-4 mr-2" />
                    Direct Thermal Print (Client)
                  </>
                )}
              </Button>

              {/* Mac-specific guidance for the browser print dialog */}
              <MacBrowserPrintTips
                labelWidthIn={currentSize.width}
                labelHeightIn={currentSize.height}
                labelName={currentSize.name}
              />

              {/* Secondary: Browser Print */}
              <Button onClick={handleBrowserPrint} variant="outline" className="w-full">
                <Monitor className="w-4 h-4 mr-2" />
                Browser Print
              </Button>
            </div>

            {/* Help Text */}
            <div className="bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded-lg p-3">
              <p className="text-sm font-semibold text-amber-900 dark:text-amber-100 mb-1">
                💡 Print Methods
              </p>
              <ul className="text-xs text-amber-700 dark:text-amber-300 space-y-1">
                <li><strong>Direct Thermal Print:</strong> Sends labels directly to your thermal printer via the ArbiProSeller Print Client (requires client running on localhost:7777)</li>
                <li><strong>Browser Print:</strong> Opens browser print dialog - select your thermal printer and ensure paper size matches</li>
              </ul>
            </div>
          </div>
        </DialogHeader>
        
        {/* Preview - Only show one label on screen */}
        <div className="mt-4 print:hidden border rounded-lg p-4 bg-gray-50 dark:bg-gray-900">
          <p className="text-xs text-muted-foreground mb-2">Preview ({currentSize.name} label):</p>
          {labels.length > 0 && (
            <ProductLabel
              asin={labels[0].asin}
              fnsku={labels[0].fnsku}
              condition={labels[0].condition}
              title={labels[0].title}
              sizeId={selectedSize}
            />
          )}
        </div>

        {/* Print - Render all labels for thermal roll */}
        <div className="hidden print:block">
          {labels.map((label, index) => (
            <div
              key={index}
              className="print-label"
              style={{ pageBreakAfter: "always" }}
            >
              <ProductLabel
                asin={label.asin}
                fnsku={label.fnsku}
                condition={label.condition}
                title={label.title}
                sizeId={selectedSize}
              />
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
};
