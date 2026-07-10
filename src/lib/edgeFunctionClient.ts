/**
 * Hardened Edge Function invocation wrapper.
 * - Extracts real HTTP status + response body from FunctionsHttpError
 * - Retries transient errors (429, 5xx) with exponential backoff
 * - Classifies errors into categories for observability
 * - Logs structured diagnostics
 * - Maintains in-memory call log for diagnostics panel
 */
import { supabase } from "@/integrations/supabase/client";

export type ErrorCategory =
  | "validation_skip"
  | "data_unavailable"
  | "transient_function_error"
  | "auth_error"
  | "runtime_error"
  | "upstream_api_error"
  | "unknown";

export interface EdgeFunctionResult<T = any> {
  ok: boolean;
  data: T | null;
  httpStatus: number | null;
  errorCategory: ErrorCategory | null;
  errorMessage: string | null;
  errorBody: any | null;
  retryCount: number;
  functionName: string;
  durationMs: number;
}

interface InvokeOptions {
  /** Function name */
  functionName: string;
  /** Request body */
  body: Record<string, any>;
  /** Max retries for transient errors (default 2) */
  maxRetries?: number;
  /** Custom headers (auth added automatically if not present) */
  headers?: Record<string, string>;
  /** Preflight validation: return a string with the reason to skip, or null to proceed */
  preflightCheck?: () => string | null;
  /** Context for logging (e.g. asin, sku) */
  context?: Record<string, string>;
}

/** Status codes that should be retried */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
/** Status codes that should NOT be retried */
const NON_RETRYABLE_STATUSES = new Set([400, 401, 403, 404, 405, 422]);

// ── In-memory call log for diagnostics ──
export interface CallLogEntry {
  id: string;
  timestamp: string;
  functionName: string;
  asin: string | null;
  sku: string | null;
  ok: boolean;
  httpStatus: number | null;
  errorCategory: ErrorCategory | null;
  errorMessage: string | null;
  retryCount: number;
  durationMs: number;
  /** True if this call succeeded only after retry (was failing, then recovered) */
  recoveredByRetry: boolean;
  /** The preflight skip reason, if this was a validation_skip */
  validationField: string | null;
}

const MAX_LOG_ENTRIES = 200;
const callLog: CallLogEntry[] = [];
let logIdCounter = 0;

function addToCallLog(result: EdgeFunctionResult, context?: Record<string, string>, extra?: { recoveredByRetry?: boolean; validationField?: string | null }) {
  const entry: CallLogEntry = {
    id: `ef-${++logIdCounter}`,
    timestamp: new Date().toISOString(),
    functionName: result.functionName,
    asin: context?.asin || null,
    sku: context?.sku || null,
    ok: result.ok,
    httpStatus: result.httpStatus,
    errorCategory: result.errorCategory,
    errorMessage: result.errorMessage,
    retryCount: result.retryCount,
    durationMs: result.durationMs,
    recoveredByRetry: extra?.recoveredByRetry || false,
    validationField: extra?.validationField || null,
  };
  callLog.unshift(entry);
  if (callLog.length > MAX_LOG_ENTRIES) callLog.length = MAX_LOG_ENTRIES;
}

/** Get the last N call log entries */
export function getCallLog(limit = 50): CallLogEntry[] {
  return callLog.slice(0, limit);
}

/** Get summary stats for a given time window (in minutes) */
export function getCallStats(windowMinutes: number) {
  const cutoff = new Date(Date.now() - windowMinutes * 60_000).toISOString();
  const recent = callLog.filter(e => e.timestamp >= cutoff);
  const success = recent.filter(e => e.ok).length;
  const failed = recent.filter(e => !e.ok).length;

  const byCategory: Record<string, number> = {};
  const asinErrors: Record<string, { count: number; lastError: string; lastCategory: string }> = {};
  const functionStats: Record<string, { ok: number; fail: number; durations: number[]; lastError: string }> = {};
  let retriedAndRecovered = 0;
  let retriedAndFailed = 0;
  const validationBlockers: Record<string, { count: number; field: string }> = {};

  for (const entry of recent) {
    // Function-level stats
    if (!functionStats[entry.functionName]) {
      functionStats[entry.functionName] = { ok: 0, fail: 0, durations: [], lastError: "" };
    }
    const fs = functionStats[entry.functionName];
    fs.durations.push(entry.durationMs);
    if (entry.ok) {
      fs.ok++;
      if (entry.recoveredByRetry) retriedAndRecovered++;
    } else {
      fs.fail++;
      fs.lastError = entry.errorMessage || "";
      const cat = entry.errorCategory || "unknown";
      byCategory[cat] = (byCategory[cat] || 0) + 1;

      if (entry.retryCount > 0) retriedAndFailed++;

      if (entry.asin) {
        if (!asinErrors[entry.asin]) {
          asinErrors[entry.asin] = { count: 0, lastError: "", lastCategory: "" };
        }
        asinErrors[entry.asin].count++;
        asinErrors[entry.asin].lastError = entry.errorMessage || "";
        asinErrors[entry.asin].lastCategory = cat;
      }

      // Track validation blockers
      if (entry.errorCategory === "validation_skip" && entry.asin) {
        const key = `${entry.asin}|${entry.sku || ""}`;
        if (!validationBlockers[key]) {
          validationBlockers[key] = { count: 0, field: entry.errorMessage || "unknown" };
        }
        validationBlockers[key].count++;
      }
    }
  }

  const topFailingAsins = Object.entries(asinErrors)
    .map(([asin, v]) => ({ asin, count: v.count, lastError: v.lastError, lastCategory: v.lastCategory }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // Dominant category
  const dominantCategory = Object.entries(byCategory).sort((a, b) => b[1] - a[1])[0] || null;

  // Top failing function
  const topFailingFunction = Object.entries(functionStats)
    .sort((a, b) => b[1].fail - a[1].fail)
    .filter(([, v]) => v.fail > 0)[0] || null;

  // Function health table
  const functionHealth = Object.entries(functionStats).map(([name, fs]) => {
    const sorted = [...fs.durations].sort((a, b) => a - b);
    const p95Idx = Math.min(Math.floor(sorted.length * 0.95), sorted.length - 1);
    return {
      name,
      total: fs.ok + fs.fail,
      successRate: fs.ok + fs.fail > 0 ? Math.round((fs.ok / (fs.ok + fs.fail)) * 100) : 100,
      avgDuration: sorted.length > 0 ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length) : 0,
      p95Duration: sorted.length > 0 ? sorted[p95Idx] : 0,
      failCount: fs.fail,
      lastError: fs.lastError,
    };
  }).sort((a, b) => b.failCount - a.failCount);

  // Data quality blockers
  const dataQualityBlockers = Object.entries(validationBlockers).map(([key, v]) => {
    const [asin, sku] = key.split("|");
    return { asin, sku: sku || null, missingField: v.field, blockedCount: v.count };
  }).sort((a, b) => b.blockedCount - a.blockedCount).slice(0, 20);

  // Category percentages
  const categoryPcts: Record<string, number> = {};
  if (failed > 0) {
    for (const [cat, count] of Object.entries(byCategory)) {
      categoryPcts[cat] = Math.round((count / failed) * 100);
    }
  }

  return {
    total: recent.length,
    success,
    failed,
    successRate: recent.length > 0 ? Math.round((success / recent.length) * 100) : 100,
    byCategory,
    categoryPcts,
    topFailingAsins,
    dominantCategory: dominantCategory ? { category: dominantCategory[0], count: dominantCategory[1] } : null,
    topFailingFunction: topFailingFunction ? { name: topFailingFunction[0], failures: topFailingFunction[1].fail } : null,
    retryOutcomes: { recovered: retriedAndRecovered, stillFailed: retriedAndFailed },
    functionHealth,
    dataQualityBlockers,
  };
}

/** Generate a copyable diagnostic summary text */
export function getDiagnosticSummary(): string {
  const stats1h = getCallStats(60);
  const stats15m = getCallStats(15);
  const lines: string[] = [
    `=== Edge Function Diagnostics ===`,
    `Generated: ${new Date().toISOString()}`,
    ``,
    `--- Last 15 min ---`,
    `Total: ${stats15m.total} | OK: ${stats15m.success} | Failed: ${stats15m.failed} (${stats15m.successRate}% success)`,
    `Dominant failure: ${stats15m.dominantCategory?.category || "none"} (${stats15m.dominantCategory?.count || 0})`,
    `Retries recovered: ${stats15m.retryOutcomes.recovered} | Still failed after retry: ${stats15m.retryOutcomes.stillFailed}`,
    ``,
    `--- Last 1 hour ---`,
    `Total: ${stats1h.total} | OK: ${stats1h.success} | Failed: ${stats1h.failed} (${stats1h.successRate}% success)`,
    `Categories: ${Object.entries(stats1h.categoryPcts).map(([c, p]) => `${c}: ${p}%`).join(", ") || "none"}`,
    ``,
    `--- Function Health (1h) ---`,
    ...stats1h.functionHealth.map(f =>
      `  ${f.name}: ${f.successRate}% ok, avg ${f.avgDuration}ms, p95 ${f.p95Duration}ms, ${f.failCount} fails${f.lastError ? ` — "${f.lastError}"` : ""}`
    ),
    ``,
    `--- Top Failing ASINs (1h) ---`,
    ...stats1h.topFailingAsins.map(a =>
      `  ${a.asin}: ${a.count}× [${a.lastCategory}] "${a.lastError}"`
    ),
    ``,
    `--- Data Quality Blockers ---`,
    ...stats1h.dataQualityBlockers.map(d =>
      `  ${d.asin} (${d.sku || "no sku"}): ${d.blockedCount}× — ${d.missingField}`
    ),
  ];
  return lines.join("\n");
}

function classifyError(status: number | null, body: any): ErrorCategory {
  if (!status) return "unknown";
  if (status === 401 || status === 403) return "auth_error";
  if (status === 429) return "upstream_api_error";
  if (status >= 500) return "transient_function_error";
  if (status === 422 || status === 400) {
    const msg = (typeof body === "string" ? body : body?.message || body?.code || "").toLowerCase();
    if (msg.includes("min") || msg.includes("max") || msg.includes("missing") || msg.includes("required")) {
      return "validation_skip";
    }
    if (msg.includes("no data") || msg.includes("unavailable") || msg.includes("not found")) {
      return "data_unavailable";
    }
    return "runtime_error";
  }
  return "unknown";
}

async function extractErrorDetails(error: any): Promise<{ status: number | null; body: any; message: string }> {
  try {
    // Supabase SDK: FunctionsHttpError.context IS the Response object directly
    const resp: Response | undefined =
      error?.context instanceof Response
        ? error.context
        : error?.context?.response instanceof Response
        ? error.context.response
        : undefined;

    if (resp) {
      const status = resp.status;
      let body: any;
      try {
        body = await resp.json();
      } catch {
        try { body = await resp.text(); } catch { body = null; }
      }
      const message = typeof body === "object" && body?.message
        ? body.message
        : typeof body === "string"
        ? body
        : error.message || "Edge Function error";
      return { status, body, message };
    }
  } catch { /* fallback below */ }

  const msg = error?.message || String(error);
  let inferredStatus: number | null = null;
  if (msg.includes("non-2xx")) inferredStatus = 500;
  if (msg.includes("timed out")) inferredStatus = 504;
  
  return { status: inferredStatus, body: null, message: msg };
}

/**
 * Invoke a Supabase Edge Function with structured error handling,
 * automatic retry for transient failures, and preflight validation.
 */
export async function invokeEdgeFunction<T = any>(
  options: InvokeOptions
): Promise<EdgeFunctionResult<T>> {
  const {
    functionName,
    body,
    maxRetries = 2,
    headers: customHeaders,
    preflightCheck,
    context,
  } = options;

  const start = performance.now();

  // ── Preflight validation ──
  if (preflightCheck) {
    const skipReason = preflightCheck();
    if (skipReason) {
      const duration = Math.round(performance.now() - start);
      console.warn(`[EdgeFn:${functionName}] Preflight skip: ${skipReason}`, context);
      const result: EdgeFunctionResult<T> = {
        ok: false,
        data: null,
        httpStatus: null,
        errorCategory: "validation_skip",
        errorMessage: skipReason,
        errorBody: null,
        retryCount: 0,
        functionName,
        durationMs: duration,
      };
      // Detect which field is missing from the skip reason
      let validationField: string | null = null;
      const reason = skipReason.toLowerCase();
      if (reason.includes("asin")) validationField = "ASIN";
      else if (reason.includes("sku")) validationField = "SKU";
      else if (reason.includes("min price")) validationField = "min_price";
      else if (reason.includes("max price")) validationField = "max_price";
      else if (reason.includes("unit cost")) validationField = "unit_cost";
      addToCallLog(result, context, { validationField });
      return result;
    }
  }

  // ── Auth header ──
  let authHeader = customHeaders?.Authorization;
  if (!authHeader) {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      const result: EdgeFunctionResult<T> = {
        ok: false,
        data: null,
        httpStatus: 401,
        errorCategory: "auth_error",
        errorMessage: "Not authenticated",
        errorBody: null,
        retryCount: 0,
        functionName,
        durationMs: Math.round(performance.now() - start),
      };
        addToCallLog(result, context);
      return result;
    }
    authHeader = `Bearer ${session.access_token}`;
  }

  const finalHeaders: Record<string, string> = {
    ...customHeaders,
    Authorization: authHeader,
  };

  // ── Invoke with retry ──
  let lastError: any = null;
  let retryCount = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      retryCount = attempt;
      const delay = Math.min(1500 * Math.pow(2.5, attempt - 1), 10000);
      console.log(`[EdgeFn:${functionName}] Retry ${attempt}/${maxRetries} in ${delay}ms`, context);
      await new Promise(r => setTimeout(r, delay));
    }

    try {
      const { data, error } = await supabase.functions.invoke(functionName, {
        body,
        headers: finalHeaders,
      });

      if (!error) {
        const result: EdgeFunctionResult<T> = {
          ok: true,
          data: data as T,
          httpStatus: 200,
          errorCategory: null,
          errorMessage: null,
          errorBody: null,
          retryCount,
          functionName,
          durationMs: Math.round(performance.now() - start),
        };
        addToCallLog(result, context, { recoveredByRetry: retryCount > 0 });
        return result;
      }

      const details = await extractErrorDetails(error);
      lastError = { ...details, retryCount };

      if (details.status && RETRYABLE_STATUSES.has(details.status) && attempt < maxRetries) {
        console.warn(
          `[EdgeFn:${functionName}] Transient error (${details.status}), will retry`,
          { message: details.message, ...context }
        );
        continue;
      }

      break;

    } catch (err: any) {
      const details = await extractErrorDetails(err);
      lastError = { ...details, retryCount: attempt };

      if (details.status && RETRYABLE_STATUSES.has(details.status) && attempt < maxRetries) {
        continue;
      }
      break;
    }
  }

  // ── Final failure ──
  const category = classifyError(lastError?.status, lastError?.body);
  const duration = Math.round(performance.now() - start);
  
  console.error(
    `[EdgeFn:${functionName}] Failed after ${retryCount + 1} attempt(s)`,
    {
      status: lastError?.status,
      category,
      message: lastError?.message,
      ...context,
      durationMs: duration,
    }
  );

  const result: EdgeFunctionResult<T> = {
    ok: false,
    data: null,
    httpStatus: lastError?.status ?? null,
    errorCategory: category,
    errorMessage: lastError?.message ?? "Unknown error",
    errorBody: lastError?.body ?? null,
    retryCount,
    functionName,
    durationMs: duration,
  };
  addToCallLog(result, context);
  return result;
}

/**
 * Helper: build a preflight check for repricer operations.
 */
export function repricerPreflightCheck(params: {
  asin?: string | null;
  sku?: string | null;
  currentPrice?: number | null;
  minPrice?: number | null;
  maxPrice?: number | null;
  unitCost?: number | null;
  requireUnitCost?: boolean;
}): string | null {
  if (!params.asin) return "ASIN is required";
  if (!params.sku) return "SKU is required";
  if (params.minPrice != null && params.minPrice <= 0) return "Min price is required but missing or zero";
  if (params.maxPrice != null && params.maxPrice <= 0) return "Max price is required but missing or zero";
  if (params.requireUnitCost && (!params.unitCost || params.unitCost <= 0)) {
    return "Unit cost is required for profit guard but missing or zero";
  }
  return null;
}
