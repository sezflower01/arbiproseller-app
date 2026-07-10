// Shared cron lock + run-history helper.
// Wrap any long-running fan-out job's "all_users" path with `withCronLock(...)`
// to guarantee no two instances run concurrently and to record observability
// rows in public.cron_run_history.
//
// Usage:
//   const result = await withCronLock(admin, "repricer-opportunity-score-30m", 1500, async () => {
//     // ... fan-out work, return { items_processed, detail }
//   });
//   if (result.skipped) return jsonResponse({ skipped_locked: true });

type AdminClient = {
  rpc: (name: string, params: Record<string, unknown>) => Promise<{ data: any; error: any }>;
};

export interface CronWorkResult {
  items_processed?: number;
  detail?: Record<string, unknown>;
}

export interface CronLockOutcome {
  skipped: boolean;
  status: "success" | "failed" | "skipped_locked";
  duration_ms: number;
  items_processed: number;
  error?: string;
  detail?: Record<string, unknown>;
}

export async function withCronLock(
  admin: AdminClient,
  jobName: string,
  ttlSeconds: number,
  work: () => Promise<CronWorkResult | void>,
): Promise<CronLockOutcome> {
  // Try to acquire
  const { data: acquired, error: lockErr } = await admin.rpc("try_acquire_cron_lock", {
    p_job_name: jobName,
    p_ttl_seconds: ttlSeconds,
  });
  if (lockErr) {
    console.warn(`[cron-lock] acquire error for ${jobName}: ${lockErr.message}`);
  }
  if (acquired === false) {
    await admin.rpc("record_cron_run", {
      p_job_name: jobName,
      p_status: "skipped_locked",
      p_duration_ms: 0,
      p_items_processed: 0,
      p_error: null,
      p_detail: { reason: "another instance already running" },
    });
    console.info(`[cron-lock] ${jobName} skipped — locked by another run`);
    return { skipped: true, status: "skipped_locked", duration_ms: 0, items_processed: 0 };
  }

  const t0 = Date.now();
  try {
    const result = (await work()) ?? {};
    const duration = Date.now() - t0;
    const items = result.items_processed ?? 0;
    await admin.rpc("record_cron_run", {
      p_job_name: jobName,
      p_status: "success",
      p_duration_ms: duration,
      p_items_processed: items,
      p_error: null,
      p_detail: result.detail ?? {},
    });
    return { skipped: false, status: "success", duration_ms: duration, items_processed: items, detail: result.detail };
  } catch (e: any) {
    const duration = Date.now() - t0;
    const msg = e?.message ?? String(e);
    await admin.rpc("record_cron_run", {
      p_job_name: jobName,
      p_status: "failed",
      p_duration_ms: duration,
      p_items_processed: 0,
      p_error: msg.slice(0, 500),
      p_detail: {},
    });
    console.error(`[cron-lock] ${jobName} failed after ${duration}ms: ${msg}`);
    return { skipped: false, status: "failed", duration_ms: duration, items_processed: 0, error: msg };
  } finally {
    await admin.rpc("release_cron_lock", { p_job_name: jobName });
  }
}
