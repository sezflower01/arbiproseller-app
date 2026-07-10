import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { jsPDF } from "npm:jspdf@2.5.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const log = (step: string, details?: unknown) => {
  const d = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[GENERATE-INVOICE-PDF] ${step}${d}`);
};

const formatDate = (dateStr: string) => {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } }
  );

  try {
    log("Function started");

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("No authorization header provided");

    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError) throw new Error(`Auth error: ${userError.message}`);
    const user = userData.user;
    if (!user?.email) throw new Error("User not authenticated");

    const { invoice_id } = await req.json();
    if (!invoice_id) throw new Error("invoice_id is required");

    log("Generating PDF for invoice", { invoice_id, userId: user.id });

    // Fetch the invoice
    const { data: invoice, error: invErr } = await supabase
      .from("generated_invoices")
      .select("*")
      .eq("id", invoice_id)
      .eq("user_id", user.id)
      .maybeSingle();

    if (invErr || !invoice) throw new Error("Invoice not found");

    // Get user profile info
    const userName = user.user_metadata?.full_name || user.user_metadata?.name || user.email;

    // Generate PDF
    const doc = new jsPDF({ unit: "pt", format: "letter" });
    const pw = doc.internal.pageSize.getWidth();
    const margin = 50;
    let y = 50;

    // --- Header ---
    doc.setFontSize(24);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(37, 99, 235); // blue-600
    doc.text("ArbiProSeller", margin, y);

    doc.setFontSize(28);
    doc.setTextColor(0, 0, 0);
    doc.text("Invoice", pw - margin, y, { align: "right" });
    y += 30;

    // --- Invoice meta ---
    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(100, 100, 100);

    const metaLines = [
      `Invoice number: ${invoice.invoice_number}`,
      `Date of issue: ${formatDate(invoice.issued_at)}`,
      `Date due: ${formatDate(invoice.due_date)}`,
    ];
    for (const line of metaLines) {
      doc.text(line, pw - margin, y, { align: "right" });
      y += 14;
    }

    y += 10;

    // --- Separator ---
    doc.setDrawColor(220, 220, 220);
    doc.line(margin, y, pw - margin, y);
    y += 20;

    // --- From / Bill To ---
    const colMid = pw / 2;

    doc.setFontSize(9);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(100, 100, 100);
    doc.text("From", margin, y);
    doc.text("Bill to", colMid + 20, y);
    y += 16;

    doc.setFont("helvetica", "normal");
    doc.setTextColor(40, 40, 40);

    const fromLines = [
      "ArbiProSeller",
      "support@arbiproseller.com",
    ];
    let fromY = y;
    for (const line of fromLines) {
      doc.text(line, margin, fromY);
      fromY += 14;
    }

    const toLines = [
      userName,
      user.email || "",
    ];
    let toY = y;
    for (const line of toLines) {
      doc.text(line, colMid + 20, toY);
      toY += 14;
    }

    y = Math.max(fromY, toY) + 20;

    // --- Amount due banner ---
    doc.setFillColor(245, 247, 250);
    doc.roundedRect(margin, y, pw - 2 * margin, 40, 4, 4, "F");
    doc.setFontSize(12);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(40, 40, 40);
    const amountStr = `$${invoice.amount.toFixed(2)} ${invoice.currency.toUpperCase()}`;
    doc.text(`${amountStr} due ${formatDate(invoice.due_date)}`, margin + 14, y + 26);
    y += 60;

    // --- Table header ---
    const colDesc = margin;
    const colQty = pw - margin - 200;
    const colUnit = pw - margin - 120;
    const colAmt = pw - margin;

    doc.setFillColor(37, 99, 235);
    doc.rect(margin, y, pw - 2 * margin, 28, "F");
    doc.setFontSize(9);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(255, 255, 255);
    doc.text("Description", colDesc + 10, y + 18);
    doc.text("Qty", colQty, y + 18, { align: "right" });
    doc.text("Unit price", colUnit, y + 18, { align: "right" });
    doc.text("Amount", colAmt, y + 18, { align: "right" });
    y += 28;

    // --- Table row ---
    doc.setFont("helvetica", "normal");
    doc.setTextColor(40, 40, 40);
    doc.setFillColor(255, 255, 255);
    doc.rect(margin, y, pw - 2 * margin, 36, "FD");

    const periodLabel = `${invoice.product_name}\n${formatDate(invoice.period_start)} – ${formatDate(invoice.period_end)}`;
    doc.setFontSize(9);
    doc.text(invoice.product_name, colDesc + 10, y + 14);
    doc.setTextColor(120, 120, 120);
    doc.setFontSize(8);
    doc.text(`${formatDate(invoice.period_start)} – ${formatDate(invoice.period_end)}`, colDesc + 10, y + 26);
    doc.setTextColor(40, 40, 40);
    doc.setFontSize(9);
    doc.text("1", colQty, y + 18, { align: "right" });
    doc.text(`$${invoice.amount.toFixed(2)}`, colUnit, y + 18, { align: "right" });
    doc.text(`$${invoice.amount.toFixed(2)}`, colAmt, y + 18, { align: "right" });
    y += 36;

    // --- Separator ---
    doc.setDrawColor(220, 220, 220);
    doc.line(margin, y, pw - margin, y);
    y += 16;

    // --- Totals ---
    const totalsX = pw - margin - 120;
    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    doc.text("Subtotal", totalsX, y);
    doc.text(`$${invoice.amount.toFixed(2)}`, colAmt, y, { align: "right" });
    y += 16;

    doc.text("Total", totalsX, y);
    doc.text(`$${invoice.amount.toFixed(2)}`, colAmt, y, { align: "right" });
    y += 16;

    doc.setFont("helvetica", "bold");
    doc.text("Amount due", totalsX, y);
    doc.text(`${amountStr}`, colAmt, y, { align: "right" });
    y += 30;

    // --- Status badge ---
    if (invoice.status === "paid") {
      doc.setFillColor(34, 197, 94);
      doc.roundedRect(margin, y, 60, 20, 4, 4, "F");
      doc.setFontSize(9);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(255, 255, 255);
      doc.text("PAID", margin + 18, y + 14);
    }

    // Output PDF as base64
    const pdfOutput = doc.output("arraybuffer");
    const pdfBytes = new Uint8Array(pdfOutput);

    log("PDF generated", { size: pdfBytes.length });

    return new Response(pdfBytes, {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="invoice-${invoice.invoice_number}.pdf"`,
      },
      status: 200,
    });
  } catch (error) {
    const msg = error instanceof Error ? (error as Error).message : String(error);
    log("ERROR", { message: msg });
    return new Response(
      JSON.stringify({ error: msg }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
    );
  }
});
