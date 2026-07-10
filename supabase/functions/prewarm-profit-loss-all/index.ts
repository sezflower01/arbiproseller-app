// Nightly P&L pre-warm orchestrator.
//
// Fans out `fetch-profit-loss` calls for every SP-API-credentialed user so
// `financial_events_cache` and `pl_month_summary` stay warm without anyone
// pressing the manual "Sync Missing Months" button.
//
// Cadence: `prewarm-profit-loss-nightly` pg_cron job at 04:00 UTC.
//
// Continuation pattern (mirrors `full-inventory-refresh-all`):
//   - Initial invocation (offset=0): acquire lock, throttle check, insert
//     `prewarm_pl_runs` row, `record_cron_run_start`. Then background-processes
//     users from offset=0 using `EdgeRuntime.waitUntil` so work survives the
//     HTTP response.
//   - When wall-clock nears the per-invocation budget, self-invokes
//     `POST /prewarm-profit-loss-all { offset, run_id, cron_run_id }` and
//     returns. The lock is held across the whole chain.
//   - Continuation invocation (offset>0): skips lock/throttle/init, loads
//     existing totals, keeps going from `offset`.
//   - Final chunk (offset reaches end): writes finished_at + totals,
//     `record_cron_run_finish`, `release_cron_lock`.
//
// Freshness rule per user: refresh current month always + any of the last 12
// months whose `pl_month_summary.computed_at` is missing or > 24h old.
//
// Current-month semantics (Option 1, mirrors "Clear Cache & Resync"):
//   Before calling fetch-profit-loss for the current month, we DELETE this
//   user's `financial_events_cache` rows in the month window and pass
//   forceRefresh:true. That way `isMonthCached` returns NOT_CACHED and
//   `processSingleMonth` actually pulls fresh events from SP-API — otherwise
//   the FAST PATH short-circuits and the cron becomes a no-op.
//   Finalized prior months keep forceRefresh:false (their events don't
//   change; the fast-path summary recompute is enough).

import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-internal-secret",
};

const JOB_NAME = "prewarm-profit-loss-nightly";
const LOCK_TTL_SECONDS = 60 * 60; // 1h — refreshed by each continuation via re-acquire skip
const STALE_HOURS = 24;
const MONTHS_BACK = 12;
const PER_MONTH_TIMEOUT_MS = 5 * 60_000;
const INTER_CALL_DELAY_MS = 800;
// Self-invoke before hitting Supabase's ~400s Edge Function wall-clock ceiling.
const WALL_CLOCK_BUDGET_MS = 300_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function monthKeyToRange(mkey: string): { start: string; end: string } {
  const [y, m] = mkey.split("-").map(Number);
  const start = `${y}-${String(m).padStart(2, "0")}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const end = `${y}-${String(m).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  return { start, end };
}

function lastNMonthKeys(n: number): string[] {
  const now = new Date();
  const keys: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    keys.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return keys;
}

interface ChainCtx {
  runId: string;
  cronRunId: number | null;
  supabaseUrl: string;
  serviceKey: string;
  userIds: string[];
  monthKeys: string[];
  currentMonth: string;
  staleCutoff: string;
  totals: { usersProcessed: number; monthsRefreshed: number; usersErrored: number };
}

async function processChunk(ctx: ChainCtx, startOffset: number) {
  const admin = createClient(ctx.supabaseUrl, ctx.serviceKey);
  const chunkStarted = Date.now();
  let i = startOffset;

  for (; i < ctx.userIds.length; i++) {
    const userId = ctx.userIds[i];
    let userErrored = false;
    try {
      const { data: summaryRows } = await admin
        .from("pl_month_summary")
        .select("month_key, computed_at")
        .eq("user_id", userId)
        .in(
          "month_key",
          ctx.monthKeys.map((k) => monthKeyToRange(k).start),
        );

      const summaryByStart = new Map<string, string>();
      for (const row of summaryRows || []) {
        summaryByStart.set(String((row as any).month_key), String((row as any).computed_at));
      }

      const targets: string[] = [];
      for (const mkey of ctx.monthKeys) {
        const { start } = monthKeyToRange(mkey);
        const computedAt = summaryByStart.get(start);
        const stale = !computedAt || computedAt < ctx.staleCutoff;
        if (mkey === ctx.currentMonth || stale) targets.push(mkey);
      }

      for (const mkey of targets) {
        const { start, end } = monthKeyToRange(mkey);
        const perMonthStarted = Date.now();
        let progressId: string | null = null;
        const isCurrentMonth = mkey === ctx.currentMonth;

        // Option 1: for the current month, mirror the "Clear Cache & Resync"
        // path — DELETE this user's FEC rows for the month, then invoke
        // fetch-profit-loss with forceRefresh:true so isMonthCached returns
        // NOT_CACHED and processSingleMonth actually pulls fresh SP-API data.
        // Finalized prior months keep forceRefresh:false (fast-path summary
        // recompute is enough; underlying events don't change).
        if (isCurrentMonth) {
          try {
            // end is inclusive YYYY-MM-DD (last day of month); event_date is
            // a date/timestamp, so lte on the last day covers the full month.
            const { error: delErr } = await admin
              .from("financial_events_cache")
              .delete()
              .eq("user_id", userId)
              .gte("event_date", start)
              .lte("event_date", end);
            if (delErr) {
              console.warn(
                `[prewarm-pl] user=${userId} month=${mkey} fec_delete_error: ${delErr.message}`,
              );
              userErrored = true;
              continue;
            }
          } catch (e) {
            console.warn(
              `[prewarm-pl] user=${userId} month=${mkey} fec_delete_throw:`,
              (e as Error).message,
            );
            userErrored = true;
            continue;
          }
        }

        try {
          const resp = await fetch(`${ctx.supabaseUrl}/functions/v1/fetch-profit-loss`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${ctx.serviceKey}`,
              apikey: ctx.serviceKey,
            },
            body: JSON.stringify({
              user_id: userId,
              startDate: `${start}T00:00:00.000Z`,
              endDate: `${end}T23:59:59.999Z`,
              forceRefresh: isCurrentMonth,
            }),
          });
          const body = await resp.text();
          try {
            progressId = JSON.parse(body)?.progressId || null;
          } catch {}
          if (!resp.ok) {
            console.warn(
              `[prewarm-pl] user=${userId} month=${mkey} upstream=${resp.status} ${body.slice(0, 200)}`,
            );
            userErrored = true;
            continue;
          }
        } catch (e) {
          console.warn(
            `[prewarm-pl] user=${userId} month=${mkey} fetch_error:`,
            (e as Error).message,
          );
          userErrored = true;
          continue;
        }

        if (progressId) {
          const deadline = Date.now() + PER_MONTH_TIMEOUT_MS;
          while (Date.now() < deadline) {
            await sleep(4000);
            const { data: pr } = await admin
              .from("pl_sync_progress")
              .select("status")
              .eq("id", progressId)
              .maybeSingle();
            const status = (pr as any)?.status;
            if (status && status !== "running" && status !== "continue") break;
          }
        }

        ctx.totals.monthsRefreshed++;
        console.log(
          `[prewarm-pl] user=${userId} month=${mkey} elapsed_ms=${Date.now() - perMonthStarted}`,
        );

        await sleep(INTER_CALL_DELAY_MS);
      }
    } catch (e) {
      console.warn(`[prewarm-pl] user=${userId} error:`, (e as Error).message);
      userErrored = true;
    }

    ctx.totals.usersProcessed++;
    if (userErrored) ctx.totals.usersErrored++;

    // Persist running totals so a crash mid-chain doesn't lose the audit trail.
    await admin
      .from("prewarm_pl_runs")
      .update({
        users_processed: ctx.totals.usersProcessed,
        months_refreshed: ctx.totals.monthsRefreshed,
        users_errored: ctx.totals.usersErrored,
      })
      .eq("id", ctx.runId);

    // Continuation gate: if we're close to the wall-clock ceiling AND there
    // are users left, self-invoke and hand off.
    const nextOffset = i + 1;
    if (
      nextOffset < ctx.userIds.length &&
      Date.now() - chunkStarted > WALL_CLOCK_BUDGET_MS
    ) {
      console.log(
        `[prewarm-pl] chunk_handoff offset=${nextOffset} of ${ctx.userIds.length} elapsed_ms=${Date.now() - chunkStarted}`,
      );
      // Re-acquire the lock to bump its TTL — the same holder can re-acquire
      // safely (idempotent) and continuations extend it without releasing.
      try {
        await admin.rpc("try_acquire_cron_lock", {
          p_job_name: JOB_NAME,
          p_ttl_seconds: LOCK_TTL_SECONDS,
        });
      } catch {}
      // Fire-and-forget the continuation; do NOT await, and do NOT wrap in
      // waitUntil here — the caller's waitUntil owns the outer worker lifetime.
      fetch(`${ctx.supabaseUrl}/functions/v1/prewarm-profit-loss-all`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ctx.serviceKey}`,
          apikey: ctx.serviceKey,
        },
        body: JSON.stringify({
          offset: nextOffset,
          run_id: ctx.runId,
          cron_run_id: ctx.cronRunId,
          user_ids: ctx.userIds,
        }),
      }).catch((e) => console.warn("[prewarm-pl] continuation invoke failed:", e?.message));
      return; // Do NOT finalize — the continuation will.
    }
  }

  // Reached end of user list — finalize.
  await admin
    .from("prewarm_pl_runs")
    .update({
      users_processed: ctx.totals.usersProcessed,
      months_refreshed: ctx.totals.monthsRefreshed,
      users_errored: ctx.totals.usersErrored,
      finished_at: new Date().toISOString(),
    })
    .eq("id", ctx.runId);

  if (ctx.cronRunId !== null) {
    try {
      await admin.rpc("record_cron_run_finish", {
        p_id: ctx.cronRunId,
        p_status: "success",
        p_rows: ctx.totals.monthsRefreshed,
        p_notes: `users=${ctx.totals.usersProcessed} errors=${ctx.totals.usersErrored}`,
      });
    } catch (e) {
      console.warn("[prewarm-pl] record_cron_run_finish failed:", (e as Error).message);
    }
  }

  try {
    await admin.rpc("release_cron_lock", { p_job_name: JOB_NAME });
  } catch (e) {
    console.warn("[prewarm-pl] release_cron_lock failed:", (e as Error).message);
  }

  console.log(
    `[prewarm-pl] FINISHED users=${ctx.totals.usersProcessed} months=${ctx.totals.monthsRefreshed} errors=${ctx.totals.usersErrored}`,
  );
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  let body: any = {};
  try {
    body = await req.json();
  } catch {}
  const offset: number = Number(body?.offset) || 0;
  const isContinuation = offset > 0 && !!body?.run_id;

  // ---------- Continuation path: skip init, just resume ----------
  if (isContinuation) {
    const { data: runRow } = await admin
      .from("prewarm_pl_runs")
      .select("id, users_processed, months_refreshed, users_errored")
      .eq("id", body.run_id)
      .maybeSingle();
    if (!runRow) {
      return new Response(JSON.stringify({ error: "run_id not found" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userIds: string[] = Array.isArray(body.user_ids) ? body.user_ids : [];
    if (userIds.length === 0) {
      return new Response(JSON.stringify({ error: "user_ids missing" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const monthKeys = lastNMonthKeys(MONTHS_BACK);
    const ctx: ChainCtx = {
      runId: body.run_id,
      cronRunId: body.cron_run_id ?? null,
      supabaseUrl,
      serviceKey,
      userIds,
      monthKeys,
      currentMonth: monthKeys[0],
      staleCutoff: new Date(Date.now() - STALE_HOURS * 3600_000).toISOString(),
      totals: {
        usersProcessed: (runRow as any).users_processed || 0,
        monthsRefreshed: (runRow as any).months_refreshed || 0,
        usersErrored: (runRow as any).users_errored || 0,
      },
    };

    // @ts-ignore EdgeRuntime is provided by Supabase
    EdgeRuntime.waitUntil(
      processChunk(ctx, offset).catch((e) =>
        console.error("[prewarm-pl] continuation fatal", e),
      ),
    );

    return new Response(
      JSON.stringify({ accepted: true, continuation: true, offset }),
      { status: 202, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // ---------- Initial invocation: lock + throttle + init ----------
  try {
    const { data: lockAcquired } = await admin.rpc("try_acquire_cron_lock", {
      p_job_name: JOB_NAME,
      p_ttl_seconds: LOCK_TTL_SECONDS,
    });
    if (lockAcquired === false) {
      return new Response(JSON.stringify({ skipped: "lock_held" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  } catch (e) {
    console.warn("[prewarm-pl] try_acquire_cron_lock failed:", (e as Error).message);
  }

  // Explicit throttle handling: both 'skip' and 'throttle' bail this run.
  // Only 'ok' (and 'unknown'/null from a stale snapshot) proceeds.
  let throttleState: string | null = null;
  try {
    const { data } = await admin.rpc("should_throttle_now");
    throttleState = typeof data === "string" ? data : null;
  } catch (e) {
    console.warn("[prewarm-pl] should_throttle_now failed:", (e as Error).message);
  }
  if (throttleState === "skip" || throttleState === "throttle") {
    await admin
      .from("prewarm_pl_runs")
      .insert({
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        throttled: true,
        notes: `throttled_${throttleState}`,
      });
    try {
      await admin.rpc("release_cron_lock", { p_job_name: JOB_NAME });
    } catch {}
    return new Response(JSON.stringify({ throttled: throttleState }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Create audit row.
  const { data: runInsert } = await admin
    .from("prewarm_pl_runs")
    .insert({ started_at: new Date().toISOString(), notes: `throttle=${throttleState || "unknown"}` })
    .select("id")
    .single();
  const runId = (runInsert as any)?.id as string;

  let cronRunId: number | null = null;
  try {
    const { data } = await admin.rpc("record_cron_run_start", {
      p_job: JOB_NAME,
      p_overlap_window_minutes: 60,
    });
    cronRunId = typeof data === "number" ? data : data ? Number(data) : null;
  } catch (e) {
    console.warn("[prewarm-pl] record_cron_run_start failed:", (e as Error).message);
  }

  // Resolve active users (SP-API-credentialed).
  const { data: credRows, error: credErr } = await admin
    .from("user_spapi_credentials")
    .select("user_id")
    .not("user_id", "is", null);

  if (credErr) {
    await admin
      .from("prewarm_pl_runs")
      .update({ finished_at: new Date().toISOString(), notes: `cred_error: ${credErr.message}` })
      .eq("id", runId);
    try {
      await admin.rpc("release_cron_lock", { p_job_name: JOB_NAME });
    } catch {}
    return new Response(JSON.stringify({ error: credErr.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const userIds = Array.from(
    new Set((credRows || []).map((r: any) => r.user_id)),
  ).filter(Boolean) as string[];

  console.log(`[prewarm-pl] START run_id=${runId} users=${userIds.length}`);

  const monthKeys = lastNMonthKeys(MONTHS_BACK);
  const ctx: ChainCtx = {
    runId,
    cronRunId,
    supabaseUrl,
    serviceKey,
    userIds,
    monthKeys,
    currentMonth: monthKeys[0],
    staleCutoff: new Date(Date.now() - STALE_HOURS * 3600_000).toISOString(),
    totals: { usersProcessed: 0, monthsRefreshed: 0, usersErrored: 0 },
  };

  // @ts-ignore EdgeRuntime is provided by Supabase
  EdgeRuntime.waitUntil(
    processChunk(ctx, 0).catch((e) => console.error("[prewarm-pl] fatal", e)),
  );

  return new Response(
    JSON.stringify({
      accepted: true,
      run_id: runId,
      users_to_process: userIds.length,
    }),
    { status: 202, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
