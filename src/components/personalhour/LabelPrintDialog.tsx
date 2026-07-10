import { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
import { ProductLabel, type LabelSizeId } from "./ProductLabel";
import { Printer } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface LabelData {
  asin: string;
  fnsku?: string | null;
  condition?: string | null;
  title: string;
}

interface LabelPrintDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  labels: LabelData[];
}

type LabelFormat = {
  id: LabelSizeId;
  name: string;
  description: string;
  sheet: {
    pageWidth: string;
    pageHeight: string;
    cols: number;
    rows: number;
    labelWidth: string;
    labelHeight: string;
    marginTop: string;
    marginLeft: string;
    gapX: string;
    gapY: string;
  };
};

const isPrintableFnsku = (fnsku?: string | null, asin?: string | null) => {
  const code = (fnsku || "").trim().toUpperCase();
  return /^X[A-Z0-9]{9}$/.test(code) && code !== (asin || "").trim().toUpperCase();
};

const A4_FORMAT: LabelFormat = {
  id: "a4-40up",
  name: "A4 large barcode labels",
  description: "A4 sheet with oversized barcodes for printing",
  sheet: {
    pageWidth: "210mm",
    pageHeight: "297mm",
    cols: 1,
    rows: 4,
    labelWidth: "210mm",
    labelHeight: "68mm",
    marginTop: "0mm",
    marginLeft: "0mm",
    gapX: "0mm",
    gapY: "0mm",
  },
};

export const LabelPrintDialog = ({ open, onOpenChange, labels }: LabelPrintDialogProps) => {
  const selectedSize: LabelSizeId = "a4-40up";
  const [startPosition, setStartPosition] = useState<number>(1);
  const { toast } = useToast();
  const sheet = A4_FORMAT.sheet;
  const labelsPerSheet = sheet.cols * sheet.rows;
  const minStartPosition = -50;
  // Positive values choose a label slot (1-4). Negative values act as mm calibration upward.
  const gridMarginTop = startPosition < 1 ? `${startPosition}mm` : "0mm";

  const handleBrowserPrint = () => {
    if (!labels || labels.length === 0) {
      toast({
        title: "No labels",
        description: "There are no labels to print.",
        variant: "destructive",
      });
      return;
    }
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

  const sheetPages = useMemo(() => {
    const pages: (LabelData | null)[][] = [];
    const offset = startPosition > 0 ? Math.max(0, Math.min(labelsPerSheet - 1, startPosition - 1)) : 0;

    let current: (LabelData | null)[] = [];
    for (let i = 0; i < offset; i++) current.push(null);

    for (const label of labels) {
      current.push(label);
      if (current.length === labelsPerSheet) {
        pages.push(current);
        current = [];
      }
    }

    if (current.length > 0) {
      while (current.length < labelsPerSheet) current.push(null);
      pages.push(current);
    }

    return pages;
  }, [labels, labelsPerSheet, startPosition]);

  const printCss = useMemo(() => {
    return `
      @media print {
        @page {
          size: ${sheet.pageWidth} ${sheet.pageHeight};
          margin: 0;
        }
        html, body {
          margin: 0;
          padding: 0;
          background: white;
        }
        body * { visibility: hidden; }
        .print-sheet, .print-sheet * { visibility: visible; }
        .print-root {
          position: fixed !important;
          top: 0 !important;
          left: 0 !important;
          width: ${sheet.pageWidth} !important;
          height: auto !important;
          max-width: none !important;
          margin: 0 !important;
          padding: 0 !important;
          background: white !important;
        }
        .print-sheet {
          position: relative;
          width: ${sheet.pageWidth};
          height: ${sheet.pageHeight};
          padding: 0;
          box-sizing: border-box;
          page-break-after: always;
          background: white;
        }
        .print-sheet:last-child { page-break-after: auto; }
        .print-grid {
          display: grid;
          grid-template-columns: repeat(${sheet.cols}, ${sheet.labelWidth});
          grid-template-rows: repeat(${sheet.rows}, ${sheet.labelHeight});
          column-gap: 0;
          row-gap: 0;
          margin: 0;
          margin-top: ${gridMarginTop};
          padding: 0;
        }
        .print-cell {
          width: ${sheet.labelWidth};
          height: ${sheet.labelHeight};
          overflow: visible;
          padding: 0;
          margin: 0;
        }
        .print-cell .product-label,
        .print-cell .barcode-wrap {
          margin: 0 !important;
          padding: 0 !important;
          border: 0 !important;
          outline: 0 !important;
          line-height: 0 !important;
          align-items: flex-start !important;
          justify-content: flex-start !important;
        }
        .print-cell svg {
          width: auto !important;
          height: 44mm !important;
          max-width: 100% !important;
          max-height: 100% !important;
          margin: 0 !important;
          padding: 0 !important;
          display: block !important;
        }
        * { box-shadow: none !important; }
      }
    `;
  }, [sheet, gridMarginTop]);

  if (!open) return null;

  return (
    <>
      <style>{printCss}</style>

      {/* On-screen panel (no dialog/overlay). Hidden when printing. */}
      <div className="label-print-panel print:hidden mb-6 border rounded-lg bg-white dark:bg-background p-4 max-w-4xl">
        <div className="flex items-start justify-between gap-4">
          <h2 className="text-lg font-semibold">Print Labels</h2>
          <Button variant="ghost" size="icon" onClick={() => onOpenChange(false)} aria-label="Close">
            <X className="w-4 h-4" />
          </Button>
        </div>

        <div className="space-y-3 pt-3">
          <p className="text-sm font-medium">Format: {A4_FORMAT.name}</p>
          <p className="text-xs text-muted-foreground">{A4_FORMAT.description}</p>

          <div className="flex items-center gap-3 flex-wrap">
            <Label className="text-sm font-medium">Start at position:</Label>
            <Input
              type="number"
              min={minStartPosition}
              max={labelsPerSheet}
              value={startPosition}
              onChange={(e) => {
                const v = parseInt(e.target.value || "1", 10);
                if (!Number.isNaN(v)) setStartPosition(Math.min(labelsPerSheet, Math.max(minStartPosition, v)));
              }}
              className="w-24"
            />
            <span className="text-xs text-muted-foreground">Position 1 = top-left. Negative numbers move up in mm.</span>
          </div>

          <p className="text-sm text-muted-foreground">
            Ready to print {labels.length} {labels.length === 1 ? "label" : "labels"} across {sheetPages.length} A4 sheet{sheetPages.length === 1 ? "" : "s"}.
          </p>

          <div className="flex flex-col gap-2">
            <Button onClick={handleBrowserPrint} className="w-full">
              <Printer className="w-4 h-4 mr-2" />
              Print A4 Sheet(s)
            </Button>

            <div className="bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 rounded-lg p-3">
              <p className="text-sm font-semibold text-blue-900 dark:text-blue-100 mb-1">💡 Tip</p>
              <p className="text-xs text-blue-700 dark:text-blue-300">
                In your browser print dialog, set paper to <strong>A4</strong>, scale to <strong>100%</strong>, and disable "Headers and footers" / "Fit to page".
              </p>
            </div>
          </div>
        </div>

        <div className="mt-4 border rounded-lg p-4 bg-gray-50 dark:bg-gray-900 overflow-auto">
          <p className="text-xs text-muted-foreground mb-2">Preview:</p>
          {labels.length > 0 && (
            <div className="inline-block border-2 border-dashed border-gray-400">
              <ProductLabel
                asin={labels[0].asin}
                fnsku={labels[0].fnsku}
                condition={labels[0].condition}
                title={labels[0].title}
                sizeId={selectedSize}
              />
            </div>
          )}
        </div>
      </div>

      {/* Print-only output. No dialog wrapper. */}
      <div className="print-root hidden print:block">
        {sheetPages.map((page, pageIdx) => (
          <div key={pageIdx} className="print-sheet">
            <div className="print-grid">
              {page.map((label, cellIdx) => (
                <div key={cellIdx} className="print-cell">
                  {label && (
                    <ProductLabel
                      asin={label.asin}
                      fnsku={label.fnsku}
                      condition={label.condition}
                      title={label.title}
                      sizeId={selectedSize}
                    />
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
};
