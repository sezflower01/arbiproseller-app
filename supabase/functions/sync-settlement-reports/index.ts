// sync-settlement-reports
// Discovers Amazon-scheduled GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2 reports,
// downloads each report document, parses the TSV, maps every row to a P&L category,
// stores raw line items, and recomputes monthly category totals.
//
// IMPORTANT: Settlement V2 reports CANNOT be manually requested via createReport
// (Amazon returns "Request for report type 1118 is not allowed"). They are auto-scheduled
// every ~14 days. Amazon retains report documents for a maximum of 90 days, so
// historical years must have been synced while still inside that retention window.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { signRequest, getLWAAccessToken, getSpApiEndpoint } from "../_shared/sp-api-sigv4.ts";
import { mapSettlementRow, parsePostedDate, parseAmount, SettlementRow, SETTLEMENT_CATEGORIES } from "../_shared/settlement-mapper.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const REPORT_TYPE = 'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2';
const RETENTION_DAYS = 90;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function overlapsRequestedRange(report: any, fromDate: string, toDate: string): boolean {
  const start = (report.dataStartTime || report.createdTime || '').slice(0, 10);
  const end = (report.dataEndTime || report.createdTime || '').slice(0, 10);
  if (!start && !end) return true;
  return (end || start) >= fromDate && (start || end) <= toDate;
}

function summarizeAmazonReport(report: any, skippedReason?: string) {
  return {
    reportId: report.reportId || null,
    reportType: report.reportType || null,
    processingStatus: report.processingStatus || null,
    createdTime: report.createdTime || null,
    dataStartTime: report.dataStartTime || null,
    dataEndTime: report.dataEndTime || null,
    marketplaceIds: report.marketplaceIds || [],
    reportDocumentIdPresent: Boolean(report.reportDocumentId),
    skippedReason: skippedReason || null,
  };
}

async function listSettlementReportsWindow(
  endpoint: string, accessToken: string, fromDate: string, toDate: string,
): Promise<{ reports: any[]; evidence: any }> {
  const all: any[] = [];
  let nextToken: string | null = null;
  let pageCount = 0;
  const evidence = { fromDate, toDate, urlParams: null as any, pages: [] as any[], error: null as string | null };
  do {
    let url: string;
    if (nextToken) {
      const p = new URLSearchParams();
      p.set('nextToken', nextToken);
      url = `${endpoint}/reports/2021-06-30/reports?${p.toString()}`;
    } else {
      const p = new URLSearchParams();
      p.set('reportTypes', REPORT_TYPE);
      p.set('processingStatuses', 'DONE');
      p.set('pageSize', '100');
      p.set('createdSince', `${fromDate}T00:00:00Z`);
      p.set('createdUntil', `${toDate}T23:59:59Z`);
      evidence.urlParams = Object.fromEntries(p.entries());
      url = `${endpoint}/reports/2021-06-30/reports?${p.toString()}`;
    }
    // Retry on 429 with exponential backoff (SP-API getReports limit: 0.0222 req/s, burst 10)
    let res: Response | null = null;
    let attempt = 0;
    while (attempt < 5) {
      const headers = await signRequest('GET', url, '', accessToken);
      res = await fetch(url, { headers });
      if (res.status !== 429) break;
      const backoffSec = Math.min(60, 15 * Math.pow(1.5, attempt)); // 15s, 22s, 34s, 51s, 60s
      console.log(`  ⏸ 429 throttled, sleeping ${Math.round(backoffSec)}s before retry ${attempt + 1}/5`);
      await res.text().catch(() => {});
      await new Promise(r => setTimeout(r, backoffSec * 1000));
      attempt++;
    }
    if (!res || !res.ok) {
      const txt = res ? await res.text() : 'no response';
      throw new Error(`getReports failed: ${res?.status} ${txt}`);
    }
    const data = await res.json();
    console.log(`  ← getReports ${fromDate} → ${toDate}: ${data.reports?.length || 0} returned`);
    evidence.pages.push({
      page: pageCount + 1,
      returned: data.reports?.length || 0,
      reports: (data.reports || []).map((r: any) => summarizeAmazonReport(r)),
      hasNextToken: Boolean(data.nextToken),
    });
    if (data.reports) {
      for (const r of data.reports) {
        if (!r.processingStatus || r.processingStatus === 'DONE') {
          all.push(r);
        }
      }
    }
    nextToken = data.nextToken || null;
    pageCount++;
    if (pageCount > 50) break;
    if (nextToken) await new Promise(r => setTimeout(r, 12_000)); // ~12s between pages
  } while (nextToken);
  return { reports: all, evidence };
}

// Walk the retrievable creation-date range in <=85-day windows. Amazon's getReports
// only filters by creation time and retains report documents for a maximum of 90 days.
async function listSettlementReports(
  endpoint: string, accessToken: string, fromDate: string, toDate: string,
): Promise<{ reports: any[]; retentionWarning: string | null; effectiveCreatedSince: string | null; effectiveCreatedUntil: string | null; retentionCutoff: string; apiWindows: any[]; amazonReportsReturned: any[]; skippedReports: any[]; }> {
  const WINDOW_DAYS = 85;
  const now = new Date();
  const retentionStartDate = isoDate(new Date(now.getTime() - RETENTION_DAYS * 86_400_000));
  const effectiveFrom = fromDate < retentionStartDate ? retentionStartDate : fromDate;
  const effectiveTo = toDate > isoDate(now) ? isoDate(now) : toDate;
  const retentionWarning = fromDate < retentionStartDate
    ? `Amazon only retains settlement report documents for ${RETENTION_DAYS} days. Reports before ${retentionStartDate} are no longer retrievable through SP-API unless they were synced earlier.`
    : null;

  if (effectiveFrom > effectiveTo) {
    console.log(`Requested range ${fromDate}→${toDate} is outside Amazon's ${RETENTION_DAYS}-day report retention window.`);
    return { reports: [], retentionWarning, effectiveCreatedSince: null, effectiveCreatedUntil: null, retentionCutoff: retentionStartDate, apiWindows: [], amazonReportsReturned: [], skippedReports: [] };
  }

  const start = new Date(`${effectiveFrom}T00:00:00Z`).getTime();
  const end = new Date(`${effectiveTo}T23:59:59Z`).getTime();
  const dayMs = 86_400_000;
  const seen = new Set<string>();
  const merged: any[] = [];
  const apiWindows: any[] = [];
  const amazonReportsReturned: any[] = [];
  const skippedReports: any[] = [];
  let cursor = start;
  while (cursor <= end) {
    const winEnd = Math.min(cursor + WINDOW_DAYS * dayMs, end);
    const f = new Date(cursor).toISOString().slice(0, 10);
    const t = new Date(winEnd).toISOString().slice(0, 10);
    console.log(`  → window ${f} → ${t}`);
    try {
      const batch = await listSettlementReportsWindow(endpoint, accessToken, f, t);
      apiWindows.push(batch.evidence);
      for (const r of batch.reports) {
        amazonReportsReturned.push(summarizeAmazonReport(r));
        if (!r.reportId) {
          skippedReports.push(summarizeAmazonReport(r, 'missing_report_id'));
        } else if (seen.has(r.reportId)) {
          skippedReports.push(summarizeAmazonReport(r, 'duplicate_report_id'));
        } else if (!overlapsRequestedRange(r, fromDate, toDate)) {
          skippedReports.push(summarizeAmazonReport(r, 'outside_requested_report_period'));
        } else {
          seen.add(r.reportId);
          merged.push(r);
        }
      }
    } catch (err: any) {
      // Don't abort entire backfill if one window fails — log and continue
      console.error(`  ✗ window ${f}→${t} failed: ${err.message}`);
      apiWindows.push({ fromDate: f, toDate: t, error: err.message, pages: [] });
    }
    cursor = winEnd + dayMs;
    // Pace ~12s between windows to respect 0.0222 req/s rate limit (burst=10).
    // 6 windows × 12s = 72s, fits comfortably under edge function timeout.
    if (cursor <= end) await new Promise(r => setTimeout(r, 12_000));
  }
  return { reports: merged, retentionWarning, effectiveCreatedSince: effectiveFrom, effectiveCreatedUntil: effectiveTo, retentionCutoff: retentionStartDate, apiWindows, amazonReportsReturned, skippedReports };
}


async function getReportDocument(
  endpoint: string, accessToken: string, documentId: string,
): Promise<{ url: string; compressionAlgorithm?: string }> {
  const url = `${endpoint}/reports/2021-06-30/documents/${encodeURIComponent(documentId)}`;
  const headers = await signRequest('GET', url, '', accessToken);
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`getReportDocument failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

async function downloadAndDecompress(docInfo: { url: string; compressionAlgorithm?: string }): Promise<string> {
  const res = await fetch(docInfo.url);
  if (!res.ok) throw new Error(`Document download failed: ${res.status}`);
  if (docInfo.compressionAlgorithm === 'GZIP') {
    const buf = new Uint8Array(await res.arrayBuffer());
    const ds = new DecompressionStream('gzip');
    const stream = new Blob([buf as any]).stream().pipeThrough(ds);
    const decompressed = await new Response(stream).arrayBuffer();
    return new TextDecoder('utf-8').decode(decompressed);
  }
  return await res.text();
}

function parseTsv(text: string): SettlementRow[] {
  const lines = text.split(/\r?\n/).filter(l => l.length > 0);
  if (lines.length < 2) return [];
  const headers = lines[0].split('\t').map(h => h.trim());
  const rows: SettlementRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split('\t');
    const row: SettlementRow = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = cells[j] ?? '';
    }
    rows.push(row);
  }
  return rows;
}

async function processReport(
  supabase: any, userId: string, endpoint: string, accessToken: string,
  amazonReport: any, marketplace: string,
): Promise<{ rows: number; settlementId?: string; startDate?: string; endDate?: string; currency?: string; }> {
  const amazonReportId = amazonReport.reportId;
  const documentId = amazonReport.reportDocumentId;
  if (!documentId) throw new Error('No reportDocumentId on report');

  // Upsert master record (pending)
  const { data: existing } = await supabase
    .from('settlement_reports')
    .select('id, status')
    .eq('user_id', userId)
    .eq('amazon_report_id', amazonReportId)
    .maybeSingle();

  if (existing?.status === 'parsed') {
    console.log(`Report ${amazonReportId} already parsed, skipping`);
    return { rows: 0 };
  }

  let reportRowId = existing?.id;
  if (!reportRowId) {
    const { data: ins, error: insErr } = await supabase
      .from('settlement_reports').insert({
        user_id: userId,
        amazon_report_id: amazonReportId,
        amazon_report_document_id: documentId,
        marketplace_id: amazonReport.marketplaceIds?.[0] || null,
        marketplace,
        settlement_start_date: amazonReport.dataStartTime?.slice(0, 10) || null,
        settlement_end_date: amazonReport.dataEndTime?.slice(0, 10) || null,
        status: 'downloading',
        raw_metadata: amazonReport,
      }).select('id').single();
    if (insErr) throw new Error(`insert settlement_reports: ${insErr.message}`);
    reportRowId = ins.id;
  } else {
    await supabase.from('settlement_reports')
      .update({ status: 'downloading', amazon_report_document_id: documentId })
      .eq('id', reportRowId);
  }

  // Download + parse
  const docInfo = await getReportDocument(endpoint, accessToken, documentId);
  const tsvText = await downloadAndDecompress(docInfo);
  const rows = parseTsv(tsvText);
  console.log(`Report ${amazonReportId}: parsed ${rows.length} TSV rows`);

  // The first non-blank row of a settlement report is a "header" row with
  // settlement-id, settlement-start-date, settlement-end-date, deposit-date, total-amount, currency
  let settlementId: string | undefined;
  let settlementStart: string | undefined;
  let settlementEnd: string | undefined;
  let depositDate: string | undefined;
  let totalAmount = 0;
  let currency: string | undefined;
  for (const r of rows) {
    if (r['settlement-id'] && r['settlement-start-date'] && r['total-amount']) {
      settlementId = r['settlement-id'];
      settlementStart = parsePostedDate({ 'posted-date': r['settlement-start-date'] }) || undefined;
      settlementEnd = parsePostedDate({ 'posted-date': r['settlement-end-date'] }) || undefined;
      depositDate = parsePostedDate({ 'posted-date': r['deposit-date'] }) || undefined;
      totalAmount = parseAmount(r['total-amount']);
      currency = r['currency'];
      break;
    }
  }

  // Wipe any prior line items for this report (idempotency)
  await supabase.from('settlement_line_items').delete().eq('settlement_report_id', reportRowId);

  // Map and bulk insert line items
  const items: any[] = [];
  for (const r of rows) {
    const mapped = mapSettlementRow(r);
    if (!mapped) continue;
    if (!mapped.amount) continue;
    items.push({
      user_id: userId,
      settlement_report_id: reportRowId,
      amazon_report_id: amazonReportId,
      posted_date: parsePostedDate(r),
      transaction_type: r['transaction-type'] || null,
      order_id: r['order-id'] || null,
      shipment_id: r['shipment-id'] || null,
      marketplace_name: r['marketplace-name'] || null,
      amount_type: r['amount-type'] || null,
      amount_description: r['amount-description'] || null,
      amount: mapped.amount,
      fulfillment_id: r['fulfillment-id'] || null,
      sku: r['sku'] || null,
      asin: null,
      quantity_purchased: r['quantity-purchased'] ? parseInt(r['quantity-purchased']) : null,
      category: mapped.category,
    });
  }

  // Insert in chunks of 500
  for (let i = 0; i < items.length; i += 500) {
    const chunk = items.slice(i, i + 500);
    const { error } = await supabase.from('settlement_line_items').insert(chunk);
    if (error) throw new Error(`insert line items: ${error.message}`);
  }

  // Update master row
  await supabase.from('settlement_reports').update({
    status: 'parsed',
    rows_parsed: items.length,
    settlement_id: settlementId,
    settlement_start_date: settlementStart || amazonReport.dataStartTime?.slice(0,10) || null,
    settlement_end_date: settlementEnd || amazonReport.dataEndTime?.slice(0,10) || null,
    deposit_date: depositDate,
    total_amount: totalAmount,
    currency,
    parsed_at: new Date().toISOString(),
    error_message: null,
  }).eq('id', reportRowId);

  return { rows: items.length, settlementId, startDate: settlementStart, endDate: settlementEnd, currency };
}

async function recomputeMonthlyTotals(supabase: any, userId: string, year: number) {
  // Aggregate settlement_line_items into settlement_category_totals for the requested year.
  // We compute per (user, year, month, marketplace=ALL, category).
  const startDate = `${year}-01-01`;
  const endDate = `${year + 1}-01-01`;

  // Pull raw aggregated rows (small enough — one query per year per user)
  const { data: agg, error } = await supabase.rpc('settlement_aggregate_year' as any, {
    p_user_id: userId, p_year: year,
  }).select?.() ?? { data: null, error: null } as any;

  // RPC may not exist — do it manually with a SELECT
  const { data: rows, error: aggErr } = await supabase
    .from('settlement_line_items')
    .select('posted_date, category, amount')
    .eq('user_id', userId)
    .gte('posted_date', startDate)
    .lt('posted_date', endDate)
    .not('category', 'is', null)
    .limit(50000);
  if (aggErr) throw new Error(`aggregate query: ${aggErr.message}`);

  const buckets = new Map<string, { total: number; count: number; year: number; month: number; category: string }>();
  for (const r of (rows || [])) {
    if (!r.posted_date) continue;
    const d = new Date(r.posted_date);
    const yr = d.getUTCFullYear();
    const mo = d.getUTCMonth() + 1;
    const key = `${yr}-${mo}-${r.category}`;
    const cur = buckets.get(key) || { total: 0, count: 0, year: yr, month: mo, category: r.category };
    cur.total += Math.abs(Number(r.amount) || 0);
    cur.count += 1;
    buckets.set(key, cur);
  }

  // Wipe existing year's totals for this user
  await supabase.from('settlement_category_totals')
    .delete()
    .eq('user_id', userId)
    .eq('period_year', year)
    .eq('marketplace', 'ALL');

  const upserts = Array.from(buckets.values()).map(b => ({
    user_id: userId,
    period_year: b.year,
    period_month: b.month,
    marketplace: 'ALL',
    category: b.category,
    total_amount: b.total,
    row_count: b.count,
    last_recomputed_at: new Date().toISOString(),
  }));

  if (upserts.length) {
    for (let i = 0; i < upserts.length; i += 200) {
      const chunk = upserts.slice(i, i + 200);
      const { error: upErr } = await supabase.from('settlement_category_totals').insert(chunk);
      if (upErr) throw new Error(`insert totals: ${upErr.message}`);
    }
  }

  return upserts.length;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseAnon = Deno.env.get('SUPABASE_ANON_KEY')!;
    const supabaseService = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    const supabaseAdmin = createClient(supabaseUrl, supabaseService);
    const internalSecret = Deno.env.get('INTERNAL_SYNC_SECRET') || '';
    const providedSecret = req.headers.get('x-internal-secret') || '';

    const body = await req.json().catch(() => ({}));

    // Two auth paths: (1) end-user with JWT, (2) internal cron with x-internal-secret + targetUserId
    let user: { id: string } | null = null;
    if (internalSecret && providedSecret && providedSecret === internalSecret && body.targetUserId) {
      user = { id: body.targetUserId };
      console.log(`[sync-settlement-reports] internal cron call for user=${body.targetUserId}`);
    } else {
      const authHeader = req.headers.get('Authorization');
      if (!authHeader) {
        return new Response(JSON.stringify({ error: 'No authorization' }), {
          status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const supabase = createClient(supabaseUrl, supabaseAnon, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: { user: authUser } } = await supabase.auth.getUser();
      if (!authUser) {
        return new Response(JSON.stringify({ error: 'Not authenticated' }), {
          status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      user = authUser;
    }
    const action = body.action || 'sync';
    const fromDate = body.fromDate || '2025-01-01';
    const toDate = body.toDate || new Date().toISOString().slice(0, 10);
    const year = body.year || new Date().getFullYear();

    if (action === 'recompute') {
      const updated = await recomputeMonthlyTotals(supabaseAdmin, user.id, year);
      return new Response(JSON.stringify({ ok: true, action: 'recompute', categoryTotalsUpdated: updated }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // === SYNC ===
    const { data: authRows } = await supabaseAdmin
      .from('seller_authorizations')
      .select('refresh_token, marketplace_id')
      .eq('user_id', user.id);
    const authData = authRows?.find((a: any) => a.marketplace_id === 'ATVPDKIKX0DER') || authRows?.[0];
    if (!authData?.refresh_token) {
      return new Response(JSON.stringify({ error: 'No Amazon seller authorization found' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const accessToken = await getLWAAccessToken(authData.refresh_token);
    const endpoint = getSpApiEndpoint(authData.marketplace_id);
    const marketplace = authData.marketplace_id === 'ATVPDKIKX0DER' ? 'US' : (authData.marketplace_id || 'US');

    console.log(`Listing settlement reports from ${fromDate} to ${toDate}`);
    const discovery = await listSettlementReports(endpoint, accessToken, fromDate, toDate);
    const reports = discovery.reports;
    if (discovery.retentionWarning) console.warn(discovery.retentionWarning);
    console.log(`Found ${reports.length} settlement reports`);

    const results: any[] = [];
    const skippedExisting: any[] = [];
    let totalRows = 0;
    let processed = 0;
    let skipped = 0;
    const errors: any[] = [];

    for (const r of reports) {
      try {
        const out = await processReport(supabaseAdmin, user.id, endpoint, accessToken, r, marketplace);
        if (out.rows === 0) {
          skipped++;
          skippedExisting.push({ ...summarizeAmazonReport(r, 'already_parsed_locally'), marketplace, currency: null });
        } else {
          processed++;
          totalRows += out.rows;
          results.push({
            reportId: r.reportId,
            reportType: r.reportType,
            marketplace,
            marketplaceIds: r.marketplaceIds || [],
            settlementId: out.settlementId,
            start: out.startDate,
            end: out.endDate,
            rows: out.rows,
            currency: out.currency,
          });
        }
        // Pace requests to respect SP-API rate limits (Reports = 0.0222 req/sec sustained)
        await new Promise(res => setTimeout(res, 800));
      } catch (err: any) {
        console.error(`Failed report ${r.reportId}:`, err.message);
        errors.push({ reportId: r.reportId, error: err.message });
        // Mark error in DB
        await supabaseAdmin.from('settlement_reports')
          .update({ status: 'error', error_message: err.message })
          .eq('user_id', user.id).eq('amazon_report_id', r.reportId);
      }
    }

    // Recompute monthly totals for affected years (start year through current year)
    const startYr = parseInt(fromDate.slice(0, 4));
    const endYr = parseInt(toDate.slice(0, 4));
    const yearsRecomputed: number[] = [];
    for (let y = startYr; y <= endYr; y++) {
      try {
        const updated = await recomputeMonthlyTotals(supabaseAdmin, user.id, y);
        yearsRecomputed.push(y);
        console.log(`Recomputed ${updated} category totals for ${y}`);
      } catch (err: any) {
        console.error(`Recompute ${y} failed:`, err.message);
      }
    }

    return new Response(JSON.stringify({
      ok: true,
      reportsFound: reports.length,
      reportsDownloaded: processed,
      processed,
      skipped,
      totalLineItems: totalRows,
      yearsRecomputed,
      retentionWarning: discovery.retentionWarning,
      requestedRange: { fromDate, toDate },
      amazonApiRange: {
        createdSince: discovery.effectiveCreatedSince,
        createdUntil: discovery.effectiveCreatedUntil,
        retentionCutoff: discovery.retentionCutoff,
        reportType: REPORT_TYPE,
      },
      effectiveCreatedSince: discovery.effectiveCreatedSince,
      effectiveCreatedUntil: discovery.effectiveCreatedUntil,
      amazonReportsReturned: discovery.amazonReportsReturned,
      skippedReports: [...discovery.skippedReports, ...skippedExisting],
      apiWindows: discovery.apiWindows,
      errors,
      results,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('sync-settlement-reports fatal:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
