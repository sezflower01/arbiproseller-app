import { Apple, AlertCircle } from "lucide-react";

const isMac = (): boolean => {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent.toLowerCase();
  const platform = (navigator.platform || "").toLowerCase();
  return ua.includes("mac") || platform.includes("mac") || ua.includes("iphone") || ua.includes("ipad");
};

interface MacBrowserPrintTipsProps {
  /** Selected label width in inches, e.g. 2 */
  labelWidthIn: number;
  /** Selected label height in inches, e.g. 1 */
  labelHeightIn: number;
  /** Display name of the label size, e.g. '2" × 1"' */
  labelName: string;
}

/**
 * Inline guidance shown ONLY on macOS so users configure the
 * print dialog correctly — exact label size, no scaling, no margins,
 * no headers/footers. Without these, Safari/Chrome on Mac will
 * silently fall back to A4 and the label will be tiny in the corner.
 */
export const MacBrowserPrintTips = ({ labelWidthIn, labelHeightIn, labelName }: MacBrowserPrintTipsProps) => {
  if (!isMac()) return null;

  return (
    <div className="rounded-md border border-primary/40 bg-primary/5 p-4 text-xs space-y-3">
      <div className="flex items-center gap-2 font-semibold text-foreground text-sm">
        <Apple className="h-4 w-4" />
        Mac Browser Print — required settings
      </div>

      <p className="text-muted-foreground">
        When the print dialog opens (⌘P), click <span className="text-foreground font-medium">"Show Details"</span> at the bottom and verify:
      </p>

      <ul className="space-y-1.5 pl-1">
        <li className="flex items-start gap-2">
          <span className="text-primary mt-0.5">✓</span>
          <span>
            <span className="text-foreground font-medium">Paper Size:</span>{" "}
            <span className="font-mono">{labelWidthIn}" × {labelHeightIn}"</span>
            {" "}(matches the selected {labelName} label). If your printer doesn't list it, choose <span className="text-foreground">Manage Custom Sizes…</span> and add one with margins set to 0.
          </span>
        </li>
        <li className="flex items-start gap-2">
          <span className="text-primary mt-0.5">✓</span>
          <span><span className="text-foreground font-medium">Scale:</span> 100% (do NOT use "Scale to Fit")</span>
        </li>
        <li className="flex items-start gap-2">
          <span className="text-primary mt-0.5">✓</span>
          <span><span className="text-foreground font-medium">Margins:</span> None</span>
        </li>
        <li className="flex items-start gap-2">
          <span className="text-primary mt-0.5">✓</span>
          <span><span className="text-foreground font-medium">Headers and Footers:</span> Off (uncheck "Print headers and footers")</span>
        </li>
        <li className="flex items-start gap-2">
          <span className="text-primary mt-0.5">✓</span>
          <span><span className="text-foreground font-medium">Background graphics:</span> On (so the barcode prints)</span>
        </li>
      </ul>

      <div className="flex items-start gap-2 pt-2 border-t border-primary/20 text-muted-foreground">
        <AlertCircle className="h-3.5 w-3.5 text-amber-500 shrink-0 mt-0.5" />
        <span>If the preview shows an A4 page with a tiny label in the corner, the paper size is wrong — fix it before clicking Print.</span>
      </div>
    </div>
  );
};

export default MacBrowserPrintTips;
