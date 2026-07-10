import { useState, useEffect } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SimplePrintDialog } from "@/components/personalhour/SimplePrintDialog";
import { Printer, Loader2, RefreshCw, Database, Download, CheckCircle, XCircle, ExternalLink } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Helmet } from "react-helmet-async";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

interface LabelData {
  asin: string;
  fnsku?: string | null;
  condition?: string | null;
  title: string;
}

interface FnskuOption {
  fnsku: string;
  condition: string | null;
}

const CLIENT_URLS = ["http://localhost:7777", "http://127.0.0.1:7777"];
const X_FNSKU_PATTERN = /^X[A-Z0-9]{9}$/;
const normalizeFnsku = (value: unknown) => (value ?? "").toString().trim().toUpperCase();

const PrintingWithoutPDF = () => {
  const { user } = useAuth();
  const { toast } = useToast();
  const [asin, setAsin] = useState("");
  const [fnsku, setFnsku] = useState("");
  const [condition, setCondition] = useState<string | null>(null);
  const [quantity, setQuantity] = useState("1");
  const [isFetching, setIsFetching] = useState(false);
  const [labelDialogOpen, setLabelDialogOpen] = useState(false);
  const [labelsForPrint, setLabelsForPrint] = useState<LabelData[]>([]);
  const [fetchedTitle, setFetchedTitle] = useState("");
  const [fetchedImageUrl, setFetchedImageUrl] = useState("");
  const [viewSyncedDialogOpen, setViewSyncedDialogOpen] = useState(false);
  const [syncedData, setSyncedData] = useState<Array<{asin: string, fnsku: string, condition: string | null}>>([]);
  const [isLoadingSyncedData, setIsLoadingSyncedData] = useState(false);
  const [availableFnskuOptions, setAvailableFnskuOptions] = useState<FnskuOption[]>([]);
  const [selectedOptionIndex, setSelectedOptionIndex] = useState<number | null>(null);
  const [manufacturerBarcodeConditions, setManufacturerBarcodeConditions] = useState<string[]>([]);
  
  // Print client status
  const [clientStatus, setClientStatus] = useState<'checking' | 'connected' | 'disconnected'>('checking');
  const [clientPrinterName, setClientPrinterName] = useState<string | null>(null);

  // Check print client status on mount
  useEffect(() => {
    checkClientStatus();
    const paramAsin = new URLSearchParams(window.location.search).get("asin")?.trim().toUpperCase();
    if (paramAsin && /^[A-Z0-9]{10}$/.test(paramAsin)) setAsin(paramAsin);
  }, []);

  const handleAsinChange = (value: string) => {
    setAsin(value);
    setFnsku("");
    setCondition(null);
    setFetchedTitle("");
    setFetchedImageUrl("");
    setAvailableFnskuOptions([]);
    setManufacturerBarcodeConditions([]);
    setSelectedOptionIndex(null);
  };

  const checkClientStatus = async () => {
    setClientStatus('checking');
    for (const baseUrl of CLIENT_URLS) {
      try {
        const response = await fetch(`${baseUrl}/health`, {
          method: 'GET',
          signal: AbortSignal.timeout(3000),
        });
        if (!response.ok) continue;
        const data = await response.json();
        setClientStatus('connected');
        setClientPrinterName(data.printerName || data.printer || null);
        return;
      } catch {
        // Try the next loopback host before showing disconnected.
      }
    }
    setClientStatus('disconnected');
  };

  const fetchProductData = async () => {
    if (!asin) {
      toast({
        title: "Error",
        description: "Please enter an ASIN",
        variant: "destructive",
      });
      return;
    }

    try {
      setIsFetching(true);
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");

      const { data: productData, error: apiError } = await supabase.functions.invoke(
        'personalhour-product-data',
        {
          body: { asin: asin.toUpperCase(), simple: true },
          headers: { Authorization: `Bearer ${session.access_token}` }
        }
      );

      if (apiError) {
        const msg = apiError.message || "";

        if (msg.includes("NOT_FOUND")) {
          toast({
            title: "ASIN not found",
            description: "Amazon could not find this ASIN in the US marketplace. FNSKU printing is blocked until a valid X00 code is available.",
            variant: "destructive",
          });
          return;
        }

        if (msg.includes("QUOTA_EXCEEDED") || msg.includes("429")) {
          toast({
            title: "Amazon quota exceeded",
            description: "We hit the SP-API rate limit while fetching product data. FNSKU printing is blocked until a valid X00 code is available.",
            variant: "destructive",
          });
          return;
        }

        toast({
          title: "Error",
          description: "Failed to fetch product data: " + msg,
          variant: "destructive",
        });
        return;
      }

      if (!productData) {
        toast({
          title: "Error",
          description: "No product data returned from Amazon.",
          variant: "destructive",
        });
        return;
      }

      setFetchedTitle(productData.title || "Unknown Product");
      setFetchedImageUrl(productData.imageUrl || "");
      
      const fetchedFnsku = await autoFetchFnsku(session);
      
      if (fetchedFnsku) {
        toast({
          title: "Success",
          description: `Product data & FNSKU retrieved! Using ${fetchedFnsku}`,
        });
      } else {
        toast({
          title: "Product data retrieved",
          description: "No printable X00 FNSKU was found. The label will not fall back to a sibling X00 or ASIN barcode.",
        });
      }
    } catch (error: any) {
      toast({
        title: "Error",
        description: "Failed to fetch product data: " + error.message,
        variant: "destructive",
      });
    } finally {
      setIsFetching(false);
    }
  };

  const autoFetchFnsku = async (session: any): Promise<string | null> => {
    const lookupAsin = asin.trim().toUpperCase();
    console.log("🔍 Auto-fetching ALL FNSKUs for ASIN:", lookupAsin);
    try {
      const { data: authRows, error: authError } = await supabase
        .from('seller_authorizations')
        .select('seller_id, marketplace_id')
        .eq('user_id', session.user.id);
      const sellerAuth = authRows?.find((r) => r.marketplace_id === 'ATVPDKIKX0DER') ?? authRows?.[0];

      if (authError || !sellerAuth) {
        console.log("⚠️ No seller authorization found");
        setAvailableFnskuOptions([]);
        setManufacturerBarcodeConditions([]);
        setSelectedOptionIndex(null);
        setFnsku("");
        setCondition("NEW");
        return null;
      }

      const readDb = async () => {
        const { data, error } = await supabase
          .from('fnsku_map')
          .select('fnsku, condition')
          .eq('seller_id', sellerAuth.seller_id)
          .eq('marketplace_id', sellerAuth.marketplace_id)
          .eq('asin', lookupAsin);
        if (error) throw error;
        return data ?? [];
      };

      let fnskuRecords: Array<{ fnsku: string; condition: string | null }> = [];
      try {
        fnskuRecords = await readDb();
      } catch (e) {
        console.error("❌ FNSKU fetch error:", e);
      }

      const getSafeOptions = (records: Array<{ fnsku: string; condition: string | null }>) => {
        const manufacturerRows = records
          .filter((r) => normalizeFnsku(r.fnsku) === lookupAsin)
          .map((r) => r.condition || "NEW");
        const printableRows = records
          .map((r) => ({ fnsku: normalizeFnsku(r.fnsku), condition: r.condition || "NEW" }))
          .filter((r) => X_FNSKU_PATTERN.test(r.fnsku) && r.fnsku !== lookupAsin);
        return { manufacturerRows: Array.from(new Set(manufacturerRows)), printableRows };
      };

      let { manufacturerRows, printableRows } = getSafeOptions(fnskuRecords);

      // Manufacturer barcode rows (FNSKU = ASIN) mean Amazon prints the ASIN, not a sibling X00.
      // Never call live lookup in that case because it can return an unrelated condition's X00.
      if (manufacturerRows.length === 0 && fnskuRecords.length < 2) {
        try {
          console.log("🔄 Syncing FNSKU options from Amazon (FBA Inventory API)…");
          const { data: liveFnsku, error: invokeErr } = await supabase.functions.invoke('get-fnsku', {
            body: { asin: lookupAsin },
          });
          if (invokeErr) console.warn("get-fnsku invoke warning:", invokeErr);
          if (normalizeFnsku(liveFnsku?.fnsku) === lookupAsin) {
            setManufacturerBarcodeConditions(["NEW"]);
            setAvailableFnskuOptions([]);
            setSelectedOptionIndex(null);
            setFnsku("");
            setCondition(null);
            return null;
          }
          fnskuRecords = await readDb();
          ({ manufacturerRows, printableRows } = getSafeOptions(fnskuRecords));
        } catch (e) {
          console.warn("get-fnsku sync failed:", e);
        }
      }

      console.log("📦 FNSKU records after sync:", fnskuRecords);

      setManufacturerBarcodeConditions(manufacturerRows);

      if (printableRows.length > 0) {
        setAvailableFnskuOptions(printableRows);
        const ambiguous = printableRows.length > 1 || manufacturerRows.length > 0;
        if (ambiguous) {
          setSelectedOptionIndex(null);
          setFnsku("");
          setCondition(null);
          return null;
        }
        setSelectedOptionIndex(0);
        setFnsku(printableRows[0].fnsku);
        setCondition(printableRows[0].condition || "NEW");
        console.log(`✅ ${printableRows.length} printable FNSKU option(s) for this ASIN`);
        return printableRows[0].fnsku;
      } else {
        console.log("⚠️ No printable X00 FNSKU found; printing blocked.");
        setAvailableFnskuOptions([]);
        setSelectedOptionIndex(null);
        setFnsku("");
        setCondition(manufacturerRows.length ? null : "NEW");
        return null;
      }
    } catch (error: any) {
      console.error("❌ Could not auto-fetch FNSKU:", error);
      setAvailableFnskuOptions([]);
      setManufacturerBarcodeConditions([]);
      setSelectedOptionIndex(null);
      return null;
    }
  };

  const selectFnskuOption = (index: number) => {
    if (index < 0 || index >= availableFnskuOptions.length) return;
    
    const option = availableFnskuOptions[index];
    setSelectedOptionIndex(index);
    setFnsku(option.fnsku);
    setCondition(option.condition || "NEW");
    
    toast({
      title: "Option selected",
      description: `Using FNSKU: ${option.fnsku} (${option.condition || 'NEW'})`,
    });
  };


  const openPrintDialog = () => {
    if (!fetchedTitle) {
      toast({
        title: "Error",
        description: "Please fetch product data first",
        variant: "destructive",
      });
      return;
    }

    const normalizedFnsku = fnsku.trim().toUpperCase();
    if (!X_FNSKU_PATTERN.test(normalizedFnsku)) {
      toast({
        title: "FNSKU required",
        description: "Enter or fetch the 10-character X00 FNSKU before printing so the barcode is not the ASIN.",
        variant: "destructive",
      });
      return;
    }

    if (selectedOptionIndex === null && (manufacturerBarcodeConditions.length > 0 || availableFnskuOptions.length > 1)) {
      toast({
        title: "Choose the exact listing",
        description: "This ASIN has multiple listing/barcode paths. Select the exact FNSKU option before printing so we do not print the wrong condition.",
        variant: "destructive",
      });
      return;
    }

    const qty = parseInt(quantity) || 1;
    if (qty < 1 || qty > 100) {
      toast({
        title: "Error",
        description: "Quantity must be between 1 and 100",
        variant: "destructive",
      });
      return;
    }

    const labels: LabelData[] = Array(qty).fill(null).map(() => ({
      asin: asin.toUpperCase(),
      fnsku: normalizedFnsku,
      condition: condition || "NEW",
      title: fetchedTitle,
    }));

    setLabelsForPrint(labels);
    setLabelDialogOpen(true);
  };

  const resetForm = () => {
    setAsin("");
    setFnsku("");
    setCondition(null);
    setQuantity("1");
    setFetchedTitle("");
    setFetchedImageUrl("");
    setAvailableFnskuOptions([]);
    setSelectedOptionIndex(null);
  };

  const updateCondition = async (newCondition: string) => {
    setCondition(newCondition);
    
    if (!fnsku || !asin) return;
    
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;

      const { data: sellerAuth } = await supabase
        .from('seller_authorizations')
        .select('seller_id, marketplace_id')
        .eq('user_id', session.user.id)
        .maybeSingle();

      if (!sellerAuth) return;

      await supabase
        .from('fnsku_map')
        .update({ condition: newCondition })
        .eq('seller_id', sellerAuth.seller_id)
        .eq('marketplace_id', sellerAuth.marketplace_id)
        .eq('asin', asin.toUpperCase());

      toast({
        title: "Condition updated",
        description: `Set to ${newCondition} for this ASIN`,
      });
    } catch (error: any) {
      console.error("Error updating condition:", error);
    }
  };

  const viewSyncedData = async () => {
    try {
      setIsLoadingSyncedData(true);
      setViewSyncedDialogOpen(true);
      
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        toast({
          title: "Not authenticated",
          description: "Please log in to view synced data",
          variant: "destructive",
        });
        setSyncedData([]);
        setIsLoadingSyncedData(false);
        return;
      }

      console.log("🔍 Current user ID:", session.user.id);

      const { data: sellerAuth, error: authError } = await supabase
        .from('seller_authorizations')
        .select('seller_id, marketplace_id')
        .eq('user_id', session.user.id)
        .maybeSingle();

      console.log("🔑 Seller authorization found:", sellerAuth);
      console.log("🔑 Seller auth error:", authError);

      if (!sellerAuth) {
        toast({
          title: "No Amazon Seller Account Connected",
          description: "Please go to 'Grant Us Access' in the menu to connect your Amazon seller account first. Then sync your inventory to see FNSKU data here.",
          variant: "destructive",
          duration: 8000,
        });
        setSyncedData([]);
        return;
      }

      const { data, error } = await supabase
        .from('fnsku_map')
        .select('asin, fnsku, condition')
        .eq('seller_id', sellerAuth.seller_id)
        .eq('marketplace_id', sellerAuth.marketplace_id)
        .order('asin', { ascending: true });

      console.log("📦 FNSKU data query result:", { count: data?.length || 0, error });

      if (error) throw error;

      setSyncedData(data || []);

      if (!data || data.length === 0) {
        toast({
          title: "No synced data found",
          description: "Click 'Sync All FNSKUs from Amazon Inventory' button to download your FBA inventory FNSKU mappings.",
          duration: 6000,
        });
      } else {
        toast({
          title: "Data loaded",
          description: `Found ${data.length} FNSKU mappings`,
        });
      }
    } catch (error: any) {
      console.error("❌ Error fetching synced data:", error);
      toast({
        title: "Error loading data",
        description: error.message || "Failed to load synced data. Please try again.",
        variant: "destructive",
      });
      setSyncedData([]);
    } finally {
      setIsLoadingSyncedData(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col">
      <Helmet>
        <title>Printing Without PDF | ArbiProSeller</title>
        <meta name="description" content="Print ASIN barcode labels directly from browser" />
      </Helmet>
      
      <Navbar />
      
      <main className="flex-grow pt-24 pb-12">
        <div className="container mx-auto px-4 max-w-2xl">
          <div className="mb-6">
            <h1 className="text-3xl font-bold">Printing Without PDF</h1>
            <p className="text-muted-foreground mt-1">
              Generate thermal printer labels with FNSKU barcodes - Direct Thermal or Browser Print
            </p>
          </div>

          {/* Print Client Setup Section */}
          <Card className="mb-6">
            <CardHeader className="pb-3">
              <CardTitle className="text-lg flex items-center gap-2">
                <Printer className="h-5 w-5" />
                Print Client Status
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {/* Status Indicator */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {clientStatus === 'checking' && (
                      <>
                        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                        <span className="text-muted-foreground">Checking connection...</span>
                      </>
                    )}
                    {clientStatus === 'connected' && (
                      <>
                        <CheckCircle className="h-5 w-5 text-green-500" />
                        <span className="text-green-600 dark:text-green-400 font-medium">
                          Connected {clientPrinterName && `• ${clientPrinterName}`}
                        </span>
                      </>
                    )}
                    {clientStatus === 'disconnected' && (
                      <>
                        <XCircle className="h-5 w-5 text-destructive" />
                        <span className="text-destructive font-medium">Not Connected</span>
                      </>
                    )}
                  </div>
                  <Button variant="ghost" size="sm" onClick={checkClientStatus}>
                    <RefreshCw className="h-4 w-4" />
                  </Button>
                </div>

                {/* Instructions when disconnected */}
                {clientStatus === 'disconnected' && (
                  <Alert>
                    <Download className="h-4 w-4" />
                    <AlertTitle>Setup Required for Direct Thermal Printing</AlertTitle>
                    <AlertDescription className="mt-2 space-y-3">
                      <p className="text-sm">
                        To use <strong>Direct Thermal Print</strong>, you need to run the ArbiProSeller Print Client on your Windows PC.
                      </p>
                      <div className="space-y-2 text-sm">
                        <p className="font-medium">Quick Setup:</p>
                        <ol className="list-decimal list-inside space-y-1 text-muted-foreground">
                          <li>Download the Print Client (requires .NET 8 Runtime)</li>
                          <li>Extract and run <code className="bg-muted px-1 py-0.5 rounded text-xs">ArbiProSeller.PrintClient.exe</code></li>
                          <li>Keep it running while printing labels</li>
                        </ol>
                      </div>
                      <div className="flex flex-wrap gap-2 pt-2">
                        <Button asChild size="sm">
                          <a 
                            href="https://github.com/ArbiProSeller/print-client/releases/latest" 
                            target="_blank" 
                            rel="noopener noreferrer"
                          >
                            <Download className="h-4 w-4 mr-2" />
                            Download Print Client
                          </a>
                        </Button>
                        <Button asChild variant="outline" size="sm">
                          <a 
                            href="https://dotnet.microsoft.com/download/dotnet/8.0" 
                            target="_blank" 
                            rel="noopener noreferrer"
                          >
                            <ExternalLink className="h-4 w-4 mr-2" />
                            Get .NET 8 Runtime
                          </a>
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground pt-2">
                        💡 Tip: You can still use <strong>Browser Print</strong> without the client - it uses your system's print dialog.
                      </p>
                    </AlertDescription>
                  </Alert>
                )}

                {clientStatus === 'connected' && (
                  <p className="text-sm text-muted-foreground">
                    ✓ Ready to print directly to your thermal printer without any dialogs.
                  </p>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Product Information</CardTitle>
              <CardDescription>
                Enter ASIN to retrieve product title, then specify how many labels to print
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* ASIN Input */}
              <div className="space-y-2">
                <label className="text-sm font-medium">ASIN</label>
                <div className="flex gap-2">
                  <Input 
                    placeholder="Enter ASIN (e.g., B07XYZ1234)" 
                    value={asin} 
                    onChange={(e) => handleAsinChange(e.target.value)}
                    className="flex-1 uppercase"
                    maxLength={10}
                  />
                  <Button 
                    onClick={fetchProductData} 
                    disabled={isFetching || !asin}
                    variant="outline"
                  >
                    {isFetching ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Fetching...
                      </>
                    ) : (
                      "Fetch Product"
                    )}
                  </Button>
                </div>
              </div>

              {manufacturerBarcodeConditions.length > 0 && (
                <div className="p-3 bg-rose-50 dark:bg-rose-900/20 border border-rose-300 dark:border-rose-800 rounded-lg text-sm">
                  <p className="font-semibold text-rose-700 dark:text-rose-300">
                    ⚠ This ASIN has a manufacturer-barcode listing — Amazon prints the ASIN, not an X00 label.
                  </p>
                  <p className="text-rose-700 dark:text-rose-300 mt-1">
                    The {manufacturerBarcodeConditions.join(', ')} listing uses manufacturer barcode mode (FNSKU = ASIN). Any X00 option belongs to another condition, so automatic printing is blocked until you select the exact listing.
                  </p>
                </div>
              )}

              {/* Selected FNSKU Display */}
              {fnsku && selectedOptionIndex !== null && (
                <div className="p-4 bg-gradient-to-r from-indigo-50 to-blue-50 dark:from-indigo-950/40 dark:to-blue-950/40 border-2 border-indigo-400 dark:border-indigo-600 rounded-lg shadow-sm ring-2 ring-indigo-300/40 dark:ring-indigo-700/40">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold uppercase tracking-wide bg-indigo-600 text-white">
                      🖨 Selected for Printing
                    </span>
                  </div>
                  <p className="text-sm font-mono font-semibold text-indigo-900 dark:text-indigo-200">
                    FNSKU: {fnsku} • Condition: {condition || 'NEW'}
                  </p>
                  <p className="text-xs text-indigo-700 dark:text-indigo-400 mt-2">
                    ✓ This FNSKU and condition will be used for the label
                  </p>
                </div>
              )}

              {/* FNSKU Display when no options available */}
              {fnsku && selectedOptionIndex === null && (
                <div className="p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg">
                  <label className="text-sm font-medium block mb-1 text-green-700 dark:text-green-400">
                    FNSKU (X00 Code)
                  </label>
                  <p className="text-sm font-mono text-green-900 dark:text-green-300">{fnsku}</p>
                  <p className="text-xs text-green-600 dark:text-green-500 mt-1">
                    ✓ FNSKU will be used for barcode printing
                  </p>
                </div>
              )}

              {fetchedTitle && (
                <div className="space-y-2">
                  <label className="text-sm font-medium">FNSKU (X00 Code)</label>
                  <Input
                    placeholder="Enter X00 code from Seller Central"
                    value={fnsku}
                    onChange={(e) => setFnsku(e.target.value.trim().toUpperCase())}
                    className="font-mono uppercase"
                    maxLength={10}
                  />
                  <p className="text-xs text-muted-foreground">
                    Labels require an X00 FNSKU; ASIN fallback printing is blocked.
                  </p>
                </div>
              )}

              {/* Product Title & Image Display */}
              {fetchedTitle && (
                <div className="p-3 bg-muted rounded-lg space-y-3">
                  <div className="flex gap-4">
                    {/* Product Image */}
                    {fetchedImageUrl && (
                      <div className="flex-shrink-0">
                        <img 
                          src={fetchedImageUrl} 
                          alt={fetchedTitle}
                          className="w-20 h-20 object-contain rounded border bg-white"
                        />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <label className="text-sm font-medium block mb-1">Product Title</label>
                      <p className="text-sm">{fetchedTitle}</p>
                      <p className="text-xs text-muted-foreground mt-1">ASIN: {asin.toUpperCase()}</p>
                    </div>
                  </div>
                  {!fnsku && (
                    <div className="text-sm text-yellow-600 dark:text-yellow-400 bg-yellow-50 dark:bg-yellow-900/20 p-2 rounded">
                      ⚠️ No printable X00 FNSKU found. Printing is blocked to prevent a wrong label.
                      <p className="text-xs mt-1 opacity-80">
                        Enter the exact X00 FNSKU from Seller Central, or this ASIN may be on manufacturer barcode mode.
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* Available FNSKU Options - Show all conditions for this ASIN */}
              {fetchedTitle && availableFnskuOptions.length > 0 && (
                <div className="space-y-2">
                  <label className="text-sm font-medium">
                    Available Inventory Options ({availableFnskuOptions.length})
                  </label>
                  <p className="text-xs text-muted-foreground mb-2">
                    Tap the exact FNSKU/condition you want to print:
                  </p>
                  <div className="space-y-3">
                    {availableFnskuOptions.map((option, index) => {
                      const cond = (option.condition || 'NEW').toUpperCase();
                      const isUsed = cond.includes('USED');
                      const isCollectible = cond.includes('COLLECTIBLE');
                      const isSelected = selectedOptionIndex === index;
                      const accent = isUsed
                        ? { border: 'border-l-orange-500', badge: 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300', dot: 'bg-orange-500' }
                        : isCollectible
                        ? { border: 'border-l-purple-500', badge: 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300', dot: 'bg-purple-500' }
                        : { border: 'border-l-green-500', badge: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300', dot: 'bg-green-500' };
                      return (
                        <div
                          key={`${option.fnsku}-${index}`}
                          onClick={() => selectFnskuOption(index)}
                          className={`relative p-4 pl-5 rounded-lg border-2 border-l-[6px] ${accent.border} cursor-pointer transition-all ${
                            isSelected
                              ? 'bg-green-50 dark:bg-green-900/30 border-green-500 dark:border-green-600 ring-2 ring-green-500/30 shadow-sm'
                              : 'bg-card hover:bg-muted/60 border-border hover:border-primary/40'
                          }`}
                        >
                          {isSelected && (
                            <span className="absolute top-2 right-2 inline-flex items-center gap-1 rounded-full bg-green-600 text-white text-[10px] font-semibold px-2 py-0.5 shadow">
                              ✓ SELECTED
                            </span>
                          )}
                          <div className="flex items-start gap-3">
                            <div className={`mt-1 h-6 w-6 shrink-0 rounded-full ${accent.dot} text-white text-xs font-bold flex items-center justify-center`}>
                              {index + 1}
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2 mb-1">
                                <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-bold tracking-wide ${accent.badge}`}>
                                  {option.condition || 'NEW'}
                                </span>
                                <span className="font-mono text-sm font-semibold text-foreground">
                                  {option.fnsku}
                                </span>
                              </div>
                              {(option as any).sku && (
                                <div className="text-[11px] text-muted-foreground mt-1">
                                  <span className="uppercase tracking-wide mr-1">Seller SKU:</span>
                                  <span className="font-mono break-all">{(option as any).sku}</span>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* No FNSKU options found - show condition dropdown as fallback */}
              {fetchedTitle && availableFnskuOptions.length === 0 && (
                <div className="space-y-2">
                  <label className="text-sm font-medium">Product Condition</label>
                  <Select 
                    value={condition || "NEW"} 
                    onValueChange={updateCondition}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select condition" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="NEW">NEW</SelectItem>
                      <SelectItem value="USED - LIKE NEW">USED - LIKE NEW</SelectItem>
                      <SelectItem value="USED - VERY GOOD">USED - VERY GOOD</SelectItem>
                      <SelectItem value="USED - GOOD">USED - GOOD</SelectItem>
                      <SelectItem value="USED - ACCEPTABLE">USED - ACCEPTABLE</SelectItem>
                      <SelectItem value="COLLECTIBLE - LIKE NEW">COLLECTIBLE - LIKE NEW</SelectItem>
                      <SelectItem value="COLLECTIBLE - VERY GOOD">COLLECTIBLE - VERY GOOD</SelectItem>
                      <SelectItem value="COLLECTIBLE - GOOD">COLLECTIBLE - GOOD</SelectItem>
                      <SelectItem value="COLLECTIBLE - ACCEPTABLE">COLLECTIBLE - ACCEPTABLE</SelectItem>
                      <SelectItem value="RENEWED">RENEWED</SelectItem>
                      <SelectItem value="OEM">OEM</SelectItem>
                      <SelectItem value="CLUB">CLUB</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    No synced inventory found. Select condition manually.
                  </p>
                </div>
              )}

              {/* Quantity Input */}
              <div className="space-y-2">
                <label className="text-sm font-medium">Number of Labels</label>
                <Input 
                  type="number" 
                  min="1"
                  max="100"
                  placeholder="How many labels?" 
                  value={quantity} 
                  onChange={(e) => setQuantity(e.target.value)}
                  disabled={!fetchedTitle}
                />
              </div>

              {/* Action Buttons */}
              <div className="space-y-2 pt-4">
                <div className="flex gap-2">
                  <Button 
                    onClick={openPrintDialog}
                    disabled={!fetchedTitle || !fnsku}
                    className="flex-1"
                  >
                    <Printer className="w-4 h-4 mr-2" />
                    Print Labels
                  </Button>
                  <Button 
                    onClick={resetForm}
                    variant="outline"
                  >
                    <RefreshCw className="w-4 h-4 mr-2" />
                    Reset
                  </Button>
                </div>
                
                <div className="border-t pt-4 space-y-2">
                  <Button 
                    onClick={viewSyncedData} 
                    variant="outline" 
                    className="w-full"
                  >
                    <Database className="w-4 h-4 mr-2" />
                    View Synced ASIN & FNSKU Data
                  </Button>
                  <p className="text-xs text-muted-foreground text-center mt-2">
                    Inventory syncs automatically every 4 hours. FNSKU lookups are instant from cache.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

        </div>
      </main>

      <Footer />

      <SimplePrintDialog
        open={labelDialogOpen}
        onOpenChange={setLabelDialogOpen}
        labels={labelsForPrint}
      />

      {/* View Synced Data Dialog */}
      <Dialog open={viewSyncedDialogOpen} onOpenChange={setViewSyncedDialogOpen}>
        <DialogContent className="max-w-4xl max-h-[80vh]">
          <DialogHeader>
            <DialogTitle>Synced ASIN & FNSKU Data</DialogTitle>
            <DialogDescription>
              All FNSKU mappings retrieved from your Amazon FBA inventory
            </DialogDescription>
          </DialogHeader>
          
          {isLoadingSyncedData ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin" />
            </div>
          ) : syncedData.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              No synced data found. Run the sync first to download your FBA inventory.
            </div>
          ) : (
            <ScrollArea className="h-[500px] w-full rounded-lg bg-amber-50 dark:bg-amber-950/20 p-4">
              <Table>
                <TableHeader>
                  <TableRow className="border-amber-200 dark:border-amber-800">
                    <TableHead className="text-amber-900 dark:text-amber-100">ASIN</TableHead>
                    <TableHead className="text-amber-900 dark:text-amber-100">FNSKU (X00)</TableHead>
                    <TableHead className="text-amber-900 dark:text-amber-100">Condition</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {syncedData.map((item, index) => (
                    <TableRow key={index} className="border-amber-200 dark:border-amber-800 hover:bg-amber-100 dark:hover:bg-amber-900/30">
                      <TableCell className="font-mono text-amber-900 dark:text-amber-100">{item.asin}</TableCell>
                      <TableCell className="font-mono text-green-700 dark:text-green-400">
                        {item.fnsku}
                      </TableCell>
                      <TableCell className="text-sm text-amber-700 dark:text-amber-300">
                        {item.condition || 'N/A'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollArea>
          )}
          
          <div className="text-sm text-muted-foreground text-center border-t pt-4">
            Total: {syncedData.length} FNSKU mappings
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default PrintingWithoutPDF;
