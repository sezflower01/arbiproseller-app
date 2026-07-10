import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ProductLabel, type LabelSizeId } from "./ProductLabel";
import { AlertTriangle, Download, ExternalLink, Image, Loader2, Monitor, Printer, RefreshCw, Upload } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { MacBrowserPrintTips } from "./MacBrowserPrintTips";
import { renderLabelToPng } from "./renderLabelToPng";
import { loadThermalSettings } from "@/lib/printerSettings";
import { Link } from "react-router-dom";

// All inline configuration UI (size/DPI/printer/language pickers, fallback
// buttons, tips, preview) is intentionally hidden. Settings now live in
// Settings → Connect Printer and are persisted in localStorage. The dialog
// auto-executes Fast Direct Thermal Print on open. Set this flag to true to
// re-enable the legacy inline UI without removing any working code.
const SHOW_INLINE_SETTINGS = false;

const PRINT_CLIENT_BUCKET = "access";
const PRINT_CLIENT_PATH = "ArbiProSellerPrintClient.exe";

type ThermalLabelSizeId = Exclude<LabelSizeId, "a4-40up">;
type PrintMode = "thermal" | "a4";
type Dpi = 203 | 300;
type PrinterLanguage = "auto" | "zpl" | "gdi";
type PrintClientResponse = {
  success?: boolean;
  error?: string;
  detail?: string;
  printer?: string;
};

interface LabelData {
  asin: string;
  fnsku?: string | null;
  condition?: string | null;
  title: string;
}

interface PrinterInfo {
  name: string;
  isDefault?: boolean;
  isThermalCandidate?: boolean;
}

interface ThermalLabelPrintDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  labels: LabelData[];
}

const LABEL_SIZES: { id: ThermalLabelSizeId; name: string; width: number; height: number }[] = [
  { id: "2x1", name: '2" × 1"', width: 2, height: 1 },
  { id: "2.25x1.25", name: '2.25" × 1.25"', width: 2.25, height: 1.25 },
  { id: "3x1", name: '3" × 1"', width: 3, height: 1 },
  { id: "3.5x2", name: '3.5" × 2"', width: 3.5, height: 2 },
];

const CLIENT_URLS = ["http://localhost:7777", "http://127.0.0.1:7777"];

const getErrorMessage = (error: unknown) => error instanceof Error ? error.message : "Failed to send labels to printer.";
const isPrintableFnsku = (fnsku?: string | null, asin?: string | null) => {
  const code = (fnsku || "").trim().toUpperCase();
  return /^X[A-Z0-9]{9}$/.test(code) && code !== (asin || "").trim().toUpperCase();
};

export const ThermalLabelPrintDialog = ({ open, onOpenChange, labels }: ThermalLabelPrintDialogProps) => {
  const { toast } = useToast();
  const initialSettings = loadThermalSettings();
  const [selectedSize, setSelectedSize] = useState<ThermalLabelSizeId>(initialSettings.sizeId);
  const [dpi, setDpi] = useState<Dpi>(initialSettings.dpi);
  const [printerLanguage, setPrinterLanguage] = useState<PrinterLanguage>(initialSettings.printerLanguage);
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [selectedPrinter, setSelectedPrinter] = useState<string>(initialSettings.printerName);
  const [clientStatus, setClientStatus] = useState<"checking" | "connected" | "disconnected">("checking");
  const [isSendingToClient, setIsSendingToClient] = useState(false);
  const [printMode, setPrintMode] = useState<PrintMode>("thermal");
  const [isDownloadingClient, setIsDownloadingClient] = useState(false);
  const [isUploadingClient, setIsUploadingClient] = useState(false);
  const [clientUrl, setClientUrl] = useState(CLIENT_URLS[0]);
  const clientUploadInputRef = useRef<HTMLInputElement | null>(null);
  // Tracks whether we've already auto-triggered direct print for this open cycle
  // so opening the dialog fires the print exactly once.
  const autoPrintedRef = useRef(false);
  // Hidden, off-screen container that mounts one <ProductLabel> per label so we
  // can rasterize each to a PNG. Keeping it in the DOM (not display:none) is
  // required for html2canvas to measure and paint correctly.
  const offscreenLabelRefs = useRef<Array<HTMLDivElement | null>>([]);

  const handleUploadPrintClient = async (file?: File | null) => {
    if (!file) return;

    if (!file.name.toLowerCase().endsWith(".exe")) {
      toast({
        title: "Invalid file",
        description: "Please upload ArbiProSellerPrintClient.exe.",
        variant: "destructive",
      });
      return;
    }

    setIsUploadingClient(true);
    try {
      const { error } = await supabase
        .storage
        .from(PRINT_CLIENT_BUCKET)
        .upload(PRINT_CLIENT_PATH, file, {
          upsert: true,
          contentType: file.type || "application/x-msdownload",
        });

      if (error) throw error;

      toast({
        title: "Print client uploaded",
        description: "The Windows Print Client download has been updated.",
      });
    } catch (err) {
      toast({
        title: "Upload failed",
        description: err instanceof Error ? err.message : "Unable to upload the print client EXE.",
        variant: "destructive",
      });
    } finally {
      setIsUploadingClient(false);
      if (clientUploadInputRef.current) clientUploadInputRef.current.value = "";
    }
  };

  const handleDownloadPrintClient = async () => {
    setIsDownloadingClient(true);
    try {
      const { data, error } = await supabase
        .storage
        .from(PRINT_CLIENT_BUCKET)
        .createSignedUrl(PRINT_CLIENT_PATH, 60 * 60);

      if (error || !data?.signedUrl) {
        throw new Error(error?.message || "Print client EXE not found in storage.");
      }

      const link = document.createElement("a");
      link.href = data.signedUrl;
      link.download = PRINT_CLIENT_PATH;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      toast({
        title: "Download started",
        description: "ArbiProSellerPrintClient.exe is downloading.",
      });
    } catch (err) {
      toast({
        title: "Download unavailable",
        description: err instanceof Error
          ? `${err.message} Ask an admin to upload ArbiProSellerPrintClient.exe to the "access" Storage bucket.`
          : "Print client EXE is not yet available.",
        variant: "destructive",
      });
    } finally {
      setIsDownloadingClient(false);
    }
  };

  const currentSize = LABEL_SIZES.find((size) => size.id === selectedSize) || LABEL_SIZES[0];

  const checkClientStatus = async () => {
    setClientStatus("checking");
    for (const baseUrl of CLIENT_URLS) {
      try {
      const [healthResponse, printersResponse] = await Promise.all([
        fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3000) }),
        fetch(`${baseUrl}/printers`, { signal: AbortSignal.timeout(3000) }),
      ]);

      if (!healthResponse.ok) throw new Error("Print client health check failed");
      const health = await healthResponse.json();
      const printerData = printersResponse.ok ? await printersResponse.json() : { printers: [] };
      const availablePrinters: PrinterInfo[] = printerData.printers || [];

      setPrinters(availablePrinters);
      setSelectedPrinter((current) => current || health.printer || availablePrinters[0]?.name || "");
      setClientUrl(baseUrl);
      setClientStatus(health.status === "ok" || availablePrinters.length > 0 ? "connected" : "disconnected");
      return;
      } catch {
        // Try the next loopback host. Some Windows/browser setups allow only one.
      }
    }
    setPrinters([]);
    setSelectedPrinter("");
    setClientStatus("disconnected");
  };

  useEffect(() => {
    if (open) {
      // Reload latest persisted settings each time the dialog opens so changes
      // made in Settings → Connect Printer take effect immediately.
      const s = loadThermalSettings();
      setSelectedSize(s.sizeId);
      setDpi(s.dpi);
      setPrinterLanguage(s.printerLanguage);
      setSelectedPrinter(s.printerName);
      autoPrintedRef.current = false;
      void checkClientStatus();
    }
  }, [open]);

  // Auto-fire Fast Direct Thermal Print as soon as the dialog opens and the
  // client reports connected. Settings are pre-configured in Settings →
  // Connect Printer, so the popup just executes the print directly.
  useEffect(() => {
    if (
      open &&
      !autoPrintedRef.current &&
      clientStatus === "connected" &&
      labels.length > 0 &&
      !isSendingToClient
    ) {
      autoPrintedRef.current = true;
      void handleDirectThermalPrint();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, clientStatus, labels.length]);

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
        dpi,
        mode: printerLanguage,
        printerName: selectedPrinter || undefined,
        labels: labels.map((label) => ({
          asin: label.asin,
          fnsku: (label.fnsku || "").trim().toUpperCase(),
          condition: label.condition || "NEW",
          title: label.title,
        })),
      };

      const response = await fetch(`${clientUrl}/print-labels`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(60000),
      });

      const responseBody = await response.text();
      let parsed: PrintClientResponse | null = null;
      try { parsed = JSON.parse(responseBody); } catch { /* not json */ }

      if (!response.ok || (parsed && parsed.success === false)) {
        const serverMsg = parsed?.error || parsed?.detail || responseBody || `HTTP ${response.status}`;
        throw new Error(`Print client error: ${serverMsg}`);
      }

      const printer = parsed?.printer ? ` (${parsed.printer})` : "";
      toast({
        title: "Labels sent to printer",
        description: `${labels.length} ${currentSize.name} label${labels.length === 1 ? "" : "s"} sent${printer}.`,
      });
      onOpenChange(false);
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      toast({
        title: "Direct print failed",
        description: message.includes("Failed to fetch")
          ? "The ArbiProSeller Print Client is not running on localhost:7777. Start it or use Browser Print fallback."
          : message,
        variant: "destructive",
      });
    } finally {
      setIsSendingToClient(false);
    }
  };

  // WYSIWYG path: rasterize each <ProductLabel> exactly as previewed and ship the
  // PNGs to the local Print Client. The EXE just stretches the bitmap to the
  // configured paper size — zero layout drift between preview and print.
  const handleImageThermalPrint = async () => {
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
      // Wait one frame so the off-screen labels are guaranteed to be in the DOM
      // and laid out before html2canvas measures them.
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

      const nodes = offscreenLabelRefs.current.filter((n): n is HTMLDivElement => !!n);
      if (nodes.length !== labels.length) {
        throw new Error("Label render container is not ready. Try again.");
      }

      // Rasterize labels in parallel with a small concurrency cap. html2canvas
      // is single-threaded per call but interleaves I/O (image decoding, font
      // loading), so running a few in parallel cuts wall-clock time by ~3-5x
      // for batches of 10+ without spiking memory the way unbounded
      // Promise.all over 100+ labels would.
      const CONCURRENCY = 4;
      const images: string[] = new Array(nodes.length);
      let nextIndex = 0;
      const workers = Array.from({ length: Math.min(CONCURRENCY, nodes.length) }, async () => {
        while (true) {
          const i = nextIndex++;
          if (i >= nodes.length) return;
          images[i] = await renderLabelToPng(nodes[i], currentSize.width, dpi);
        }
      });
      await Promise.all(workers);

      const payload = {
        sizeId: selectedSize,
        printerName: selectedPrinter || undefined,
        images,
      };

      const response = await fetch(`${clientUrl}/print-image-labels`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        // Generous timeout: large batches with PNG payloads can take a moment.
        signal: AbortSignal.timeout(60000),
      });

      const responseBody = await response.text();
      let parsed: PrintClientResponse | null = null;
      try { parsed = JSON.parse(responseBody); } catch { /* not json */ }

      if (response.status === 404) {
        throw new Error(
          "This print client is too old to support WYSIWYG image printing. " +
          "Download the latest ArbiProSellerPrintClient.exe and replace the running copy."
        );
      }

      if (!response.ok || (parsed && parsed.success === false)) {
        const serverMsg = parsed?.error || parsed?.detail || responseBody || `HTTP ${response.status}`;
        throw new Error(`Print client error: ${serverMsg}`);
      }

      const printer = parsed?.printer ? ` (${parsed.printer})` : "";
      toast({
        title: "Labels sent to printer",
        description: `${labels.length} ${currentSize.name} label${labels.length === 1 ? "" : "s"} sent${printer}.`,
      });
      onOpenChange(false);
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      toast({
        title: "Direct print failed",
        description: message.includes("Failed to fetch")
          ? "The ArbiProSeller Print Client is not running on localhost:7777. Start it or use Browser Print fallback."
          : message,
        variant: "destructive",
      });
    } finally {
      setIsSendingToClient(false);
    }
  };

  const triggerPrint = (mode: PrintMode) => {
    if (labels.some((label) => !isPrintableFnsku(label.fnsku, label.asin))) {
      toast({
        title: "FNSKU required",
        description: "Printing is blocked because one or more labels do not have a valid X00 FNSKU.",
        variant: "destructive",
      });
      return;
    }
    setPrintMode(mode);
    window.setTimeout(() => window.print(), 0);
  };

  const a4Pages = useMemo(() => {
    const pages: (LabelData | null)[][] = [];
    let current: (LabelData | null)[] = [];
    labels.forEach((label) => {
      current.push(label);
      if (current.length === 4) {
        pages.push(current);
        current = [];
      }
    });
    if (current.length) {
      while (current.length < 4) current.push(null);
      pages.push(current);
    }
    return pages;
  }, [labels]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[86vh] overflow-y-auto print:overflow-visible print:border-0 print:shadow-none">
        <style>{`
          @media print {
            @page {
              size: ${printMode === "a4" ? "210mm 297mm" : `${currentSize.width}in ${currentSize.height}in`};
              margin: 0;
            }
            html, body {
              margin: 0 !important;
              padding: 0 !important;
              background: white !important;
            }
            body * { visibility: hidden !important; }
            .thermal-print-output, .thermal-print-output * { visibility: visible !important; }
            .thermal-print-output {
              position: fixed !important;
              inset: 0 auto auto 0 !important;
              width: ${printMode === "a4" ? "210mm" : `${currentSize.width}in`} !important;
              margin: 0 !important;
              padding: 0 !important;
              background: white !important;
            }
            .thermal-print-label {
              width: ${currentSize.width}in !important;
              height: ${currentSize.height}in !important;
              page-break-after: always;
              overflow: hidden !important;
            }
            .thermal-print-label:last-child { page-break-after: auto; }
            .a4-print-sheet {
              width: 210mm !important;
              height: 297mm !important;
              page-break-after: always;
              display: grid !important;
              grid-template-columns: 210mm !important;
              grid-template-rows: repeat(4, 68mm) !important;
              overflow: hidden !important;
            }
            .a4-print-sheet:last-child { page-break-after: auto; }
            * { box-shadow: none !important; }
          }
        `}</style>

        <DialogHeader className="print:hidden">
          <DialogTitle>Print FNSKU Labels</DialogTitle>
        </DialogHeader>

        {!SHOW_INLINE_SETTINGS && (
          <div className="space-y-4 print:hidden">
            {clientStatus === "checking" && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Connecting to print client…
              </div>
            )}
            {clientStatus === "connected" && (
              <div className="flex items-center gap-2 text-sm">
                {isSendingToClient ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                    <span>Sending {labels.length} {currentSize.name} label{labels.length === 1 ? "" : "s"} to {selectedPrinter || "printer"}…</span>
                  </>
                ) : (
                  <>
                    <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
                    <span>Connected to {selectedPrinter || "printer"} • {currentSize.name} @ {dpi} DPI</span>
                  </>
                )}
              </div>
            )}
            {clientStatus === "disconnected" && (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm space-y-2">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <p className="font-semibold text-foreground">Print Client not running</p>
                    <p className="text-muted-foreground mt-1">
                      Start ArbiProSeller Print Client, or configure printing in{" "}
                      <Link to="/settings" className="underline">Settings → Connect Printer</Link>.
                    </p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button type="button" size="sm" variant="outline" onClick={checkClientStatus}>
                    <RefreshCw className="h-4 w-4 mr-2" /> Retry
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => onOpenChange(false)}>
                    Close
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {SHOW_INLINE_SETTINGS && (
        <div className="space-y-4 print:hidden">
          <div className="grid gap-3 md:grid-cols-3">
            <div className="space-y-2">
              <label className="text-sm font-medium">Label size</label>
              <Select value={selectedSize} onValueChange={(value) => setSelectedSize(value as ThermalLabelSizeId)}>
                <SelectTrigger>
                  <SelectValue placeholder="Select size" />
                </SelectTrigger>
                <SelectContent>
                  {LABEL_SIZES.map((size) => (
                    <SelectItem key={size.id} value={size.id}>{size.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Printer DPI</label>
              <Select value={String(dpi)} onValueChange={(value) => setDpi(Number(value) as Dpi)}>
                <SelectTrigger>
                  <SelectValue placeholder="Select DPI" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="203">203 DPI</SelectItem>
                  <SelectItem value="300">300 DPI</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Windows printer</label>
              <Select value={selectedPrinter || "auto"} onValueChange={(value) => setSelectedPrinter(value === "auto" ? "" : value)}>
                <SelectTrigger>
                  <SelectValue placeholder="Auto-detect" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Auto-detect thermal printer</SelectItem>
                  {printers.map((printer) => (
                    <SelectItem key={printer.name} value={printer.name}>{printer.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2 md:col-span-3">
              <label className="text-sm font-medium">Printer language</label>
              <Select value={printerLanguage} onValueChange={(v) => setPrinterLanguage(v as PrinterLanguage)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Auto-detect (recommended) — Zebra → ZPL, Rollo/DYMO → Windows driver</SelectItem>
                  <SelectItem value="zpl">ZPL — Zebra printers (raw ZPL commands)</SelectItem>
                  <SelectItem value="gdi">Windows driver — Rollo, DYMO, Brother, generic thermal</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                If the toast says "sent" but nothing prints, your printer doesn't speak ZPL. Switch to <strong>Windows driver</strong>.
              </p>
            </div>
          </div>
          {clientStatus === "connected" ? (
            <div className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2">
                  <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
                  Print Client: connected{selectedPrinter ? ` • ${selectedPrinter}` : ""}
                </span>
                <Button type="button" variant="ghost" size="sm" onClick={checkClientStatus}>
                  <RefreshCw className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ) : (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
              <div className="flex items-start gap-3">
                <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5 shrink-0" />
                <div className="flex-1 space-y-3">
                  <div>
                    <p className="font-semibold text-foreground">
                      Print Client {clientStatus === "checking" ? "checking…" : "not connected"}
                    </p>
                    <p className="text-muted-foreground mt-1">
                      Thermal direct printing needs the local Windows print client running on this PC.
                      Without it, only the Browser Print fallback (which goes through the Windows print dialog) will work.
                    </p>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <input
                      ref={clientUploadInputRef}
                      type="file"
                      accept=".exe,application/x-msdownload,application/vnd.microsoft.portable-executable"
                      className="hidden"
                      onChange={(event) => void handleUploadPrintClient(event.target.files?.[0])}
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="default"
                      onClick={() => clientUploadInputRef.current?.click()}
                      disabled={isUploadingClient}
                    >
                      {isUploadingClient ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <Upload className="h-4 w-4 mr-2" />
                      )}
                      Upload Windows Print Client
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={handleDownloadPrintClient}
                      disabled={isDownloadingClient}
                    >
                      {isDownloadingClient ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <Download className="h-4 w-4 mr-2" />
                      )}
                      Download Windows Print Client
                    </Button>
                    <Button type="button" size="sm" variant="outline" asChild>
                      <a
                        href="https://github.com/arbiproseller/print-client#quick-start-end-user"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <ExternalLink className="h-4 w-4 mr-2" />
                        Setup Instructions
                      </a>
                    </Button>
                    <Button type="button" size="sm" variant="outline" onClick={checkClientStatus}>
                      <RefreshCw className="h-4 w-4 mr-2" />
                      Retry Connection
                    </Button>
                  </div>

                  <div className="text-xs text-muted-foreground space-y-1">
                    <p>
                      Verify the client is running:{" "}
                      <a
                        href="http://localhost:7777/health"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline font-mono"
                      >
                        http://localhost:7777/health
                      </a>{" "}
                      should return <code className="font-mono">{"{ status: \"ok\" }"}</code>.
                    </p>
                    <p>
                      <strong>Auto-start tip:</strong> after testing, place a shortcut to{" "}
                      <code className="font-mono">ArbiProSellerPrintClient.exe</code> in{" "}
                      <code className="font-mono">shell:startup</code> (Win+R → <code>shell:startup</code>) so it
                      launches automatically when Windows starts.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}

          <MacBrowserPrintTips
            labelWidthIn={currentSize.width}
            labelHeightIn={currentSize.height}
            labelName={currentSize.name}
          />

          <div className="space-y-2">
            <Button onClick={handleDirectThermalPrint} disabled={isSendingToClient || labels.length === 0 || clientStatus !== "connected"} className="w-full">
              {isSendingToClient ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Printer className="w-4 h-4 mr-2" />}
              Fast Direct Thermal Print
            </Button>
            <Button onClick={handleImageThermalPrint} disabled={isSendingToClient || labels.length === 0 || clientStatus !== "connected"} variant="outline" className="w-full">
              {isSendingToClient ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Image className="w-4 h-4 mr-2" />}
              Exact Image Print — slower fallback
            </Button>
            <Button onClick={() => triggerPrint("thermal")} variant="outline" className="w-full">
              <Monitor className="w-4 h-4 mr-2" />
              Browser Print — Fallback (works on Mac & Windows)
            </Button>
            <Button onClick={() => triggerPrint("a4")} variant="secondary" className="w-full">
              A4 Sheet Print — separate option
            </Button>
          </div>

          <div className="rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
            Browser fallback warning: your printer's paper size must match the selected label size exactly. If the print dialog shows A4, fix it in the dialog (Mac: see tips above) or in printer preferences (Windows).
          </div>

          <div className="rounded-md border border-border bg-muted/40 p-4 overflow-auto">
            <p className="text-xs text-muted-foreground mb-2">Preview ({currentSize.name})</p>
            {labels[0] && <ProductLabel {...labels[0]} sizeId={selectedSize} />}
          </div>
        </div>
        )}

        <div className="thermal-print-output hidden print:block">
          {printMode === "thermal" ? (
            labels.map((label, index) => (
              <div key={index} className="thermal-print-label">
                <ProductLabel {...label} sizeId={selectedSize} />
              </div>
            ))
          ) : (
            a4Pages.map((page, pageIndex) => (
              <div key={pageIndex} className="a4-print-sheet">
                {page.map((label, labelIndex) => (
                  <div key={labelIndex}>{label && <ProductLabel {...label} sizeId="a4-40up" />}</div>
                ))}
              </div>
            ))
          )}
        </div>

        {/*
          Off-screen render container for the WYSIWYG print path.
          Each label is mounted at its real physical size so html2canvas can
          rasterize it to a pixel-perfect PNG. Positioned far off-screen and
          aria-hidden so it never interferes with the visible UI or print preview.
        */}
        <div
          aria-hidden="true"
          className="print:hidden"
          style={{
            position: "fixed",
            left: "-10000px",
            top: 0,
            pointerEvents: "none",
            opacity: 1,
            background: "white",
          }}
        >
          {labels.map((label, index) => (
            <div
              key={`offscreen-${index}`}
              ref={(el) => { offscreenLabelRefs.current[index] = el; }}
              style={{ background: "white" }}
            >
              <ProductLabel {...label} sizeId={selectedSize} />
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
};