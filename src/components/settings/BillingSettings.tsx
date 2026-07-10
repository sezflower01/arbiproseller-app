import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Download, ExternalLink, FileText, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface Invoice {
  id: string;
  number: string | null;
  status: string | null;
  amount_due: number;
  amount_paid: number;
  currency: string;
  created: number;
  due_date: number | null;
  hosted_invoice_url: string | null;
  invoice_pdf: string | null;
  product_name: string | null;
  source: string;
}

const statusVariant = (status: string | null) => {
  switch (status) {
    case "paid":
      return "default";
    case "open":
      return "secondary";
    case "draft":
      return "outline";
    case "void":
    case "uncollectible":
      return "destructive";
    default:
      return "outline";
  }
};

const formatCurrency = (amount: number, currency: string) => {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(amount / 100);
};

const formatCurrencyRaw = (amount: number, currency: string) => {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(amount);
};

const formatDate = (ts: number | null) => {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
};

export default function BillingSettings() {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    const fetchInvoices = async () => {
      setLoading(true);
      setError(null);
      try {
        const { data, error: fnErr } = await supabase.functions.invoke("list-invoices");
        if (fnErr) throw new Error(fnErr.message);
        setInvoices(data?.invoices ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load invoices");
      } finally {
        setLoading(false);
      }
    };
    fetchInvoices();
  }, []);

  const handleDownloadGeneratedPdf = async (invoiceId: string, invoiceNumber: string) => {
    setDownloadingId(invoiceId);
    try {
      const { data, error: fnErr } = await supabase.functions.invoke("generate-invoice-pdf", {
        body: { invoice_id: invoiceId },
      });

      if (fnErr) throw new Error(fnErr.message);

      // data comes as Blob from binary response
      const blob = data instanceof Blob ? data : new Blob([data], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `invoice-${invoiceNumber}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      toast({
        title: "Download failed",
        description: err instanceof Error ? err.message : "Could not generate PDF",
        variant: "destructive",
      });
    } finally {
      setDownloadingId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
        <span className="ml-2 text-muted-foreground text-sm">Loading invoices…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-center">
        <p className="text-destructive text-sm">{error}</p>
      </div>
    );
  }

  if (invoices.length === 0) {
    return (
      <div className="rounded-lg border border-white/10 bg-white/5 p-10 text-center">
        <FileText className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
        <p className="text-muted-foreground text-sm">No invoices yet</p>
        <p className="text-muted-foreground/60 text-xs mt-1">
          Invoices will appear here once you have an active subscription.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-white">Billing & Invoices</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          View and download your payment invoices.
        </p>
      </div>

      <div className="rounded-lg border border-white/10 bg-white/5 overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="border-white/10 hover:bg-transparent">
              <TableHead className="text-white text-xs font-medium">Status</TableHead>
              <TableHead className="text-white text-xs font-medium">Amount</TableHead>
              <TableHead className="text-white text-xs font-medium">Product</TableHead>
              <TableHead className="text-white text-xs font-medium">Date Issued</TableHead>
              <TableHead className="text-white text-xs font-medium">Due Date</TableHead>
              <TableHead className="text-white text-xs font-medium">Invoice ID</TableHead>
              <TableHead className="text-white text-xs font-medium text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {invoices.map((inv) => (
              <TableRow key={inv.id} className="border-white/10 hover:bg-white/5">
                <TableCell>
                  <Badge variant={statusVariant(inv.status)} className="capitalize text-[10px]">
                    {inv.status ?? "unknown"}
                  </Badge>
                </TableCell>
                <TableCell className="text-white text-sm font-medium">
                  {inv.source === "generated"
                    ? formatCurrencyRaw(inv.amount_due, inv.currency)
                    : formatCurrency(inv.amount_due, inv.currency)}
                </TableCell>
                <TableCell className="text-white/80 text-sm max-w-[200px] truncate">
                  {inv.product_name ?? "—"}
                </TableCell>
                <TableCell className="text-white/80 text-sm">
                  {formatDate(inv.created)}
                </TableCell>
                <TableCell className="text-white/80 text-sm">
                  {formatDate(inv.due_date)}
                </TableCell>
                <TableCell className="text-white/80 text-xs font-mono">
                  {inv.number ?? inv.id}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-1">
                    {/* Stripe PDF */}
                    {inv.source === "stripe" && inv.invoice_pdf && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-white hover:text-white hover:bg-transparent"
                        asChild
                      >
                        <a href={inv.invoice_pdf} target="_blank" rel="noopener noreferrer" title="Download PDF">
                          <Download className="h-3.5 w-3.5" />
                        </a>
                      </Button>
                    )}
                    {/* Generated PDF */}
                    {inv.source === "generated" && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-white hover:text-white hover:bg-transparent"
                        disabled={downloadingId === inv.id}
                        onClick={() => handleDownloadGeneratedPdf(inv.id, inv.number ?? inv.id)}
                        title="Download PDF"
                      >
                        {downloadingId === inv.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Download className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    )}
                    {inv.hosted_invoice_url && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-white hover:text-white hover:bg-transparent"
                        asChild
                      >
                        <a href={inv.hosted_invoice_url} target="_blank" rel="noopener noreferrer" title="View invoice">
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
