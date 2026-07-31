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
// Absolute ceiling on the initial (synchronous) fetch-profit-loss call —
// without this, a slow or hung call blocks the whole invocation with no
// escape hatch, silently blowing through the real runtime ceiling exactly
// like the polling loop could before it got a budget check.
const FETCH_CALL_TIMEOUT_MS = 60_000;
// Self-invoke before hitting the Edge Runtime's real ~150s wall-clock ceiling
// for waitUntil-continued executions (confirmed via live-captured stalls
// elsewhere in this codebase — NOT the ~400s previously assumed here).
const WALL_CLOCK_BUDGET_MS = 100_000;
const CONTINUE_RETRY_ATTEMPTS = 3;
const CONTINUE_RETRY_BACKOFF_MS = 1500;

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

// Retries the self-continuation POST with backoff so a single transient
// network hiccup doesn't orphan the rest of the chain (the exact failure
// mode observed once with sync-fnsku-report's one-shot fire-and-forget).
async function selfContinue(ctx: ChainCtx, offset: number) {
  for (let attempt = 1; attempt <= CONTINUE_RETRY_ATTEMPTS; attempt++) {
    try {
      const resp = await fetch(`${ctx.supabaseUrl}/functions/v1/prewarm-profit-loss-all`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ctx.serviceKey}`,
          apikey: ctx.serviceKey,
        },
        body: JSON.stringify({
          offset,
          run_id: ctx.runId,
          cron_run_id: ctx.cronRunId,
          user_ids: ctx.userIds,
        }),
      });
      if (resp.ok || resp.status === 202) return;
      console.warn(`[prewarm-pl] selfContinue attempt=${attempt} status=${resp.status}`);
    } catch (e) {
      console.warn(`[prewarm-pl] selfContinue attempt=${attempt} error:`, (e as Error).message);
    }
    if (attempt < CONTINUE_RETRY_ATTEMPTS) await sleep(CONTINUE_RETRY_BACKOFF_MS * attempt);
  }
  console.error(`[prewarm-pl] selfContinue exhausted retries offset=${offset} run_id=${ctx.runId}`);
}

async function processChunk(ctx: ChainCtx, startOffset: number) {
  const admin = createClient(ctx.supabaseUrl, ctx.serviceKey);
  const chunkStarted = Date.now();
  let i = startOffset;

  // Persists totals and hands off to a continuation at the given user offset.
  // Reusable for both a clean user-boundary handoff and a mid-user bail-out —
  // in the latter case `offset` stays on the SAME user, and the next
  // invocation's fresh `pl_month_summary` staleness check naturally skips
  // whatever months already got a fresh `computed_at` in this chunk, so no
  // separate month-level cursor needs to be persisted.
  async function handoff(offset: number) {
    await admin
      .from("prewarm_pl_runs")
      .update({
        users_processed: ctx.totals.usersProcessed,
        months_refreshed: ctx.totals.monthsRefreshed,
        users_errored: ctx.totals.usersErrored,
        offset_idx: offset,
        last_heartbeat_at: new Date().toISOString(),
      })
      .eq("id", ctx.runId);

    console.log(
      `[prewarm-pl] chunk_handoff offset=${offset} of ${ctx.userIds.length} elapsed_ms=${Date.now() - chunkStarted}`,
    );
    try {
      await admin.rpc("try_acquire_cron_lock", {
        p_job_name: JOB_NAME,
        p_ttl_seconds: LOCK_TTL_SECONDS,
      });
    } catch {}
    await selfContinue(ctx, offset);
  }

  for (; i < ctx.userIds.length; i++) {
    const userId = ctx.userIds[i];
    let userErrored = false;
    let budgetExceeded = false;
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

        if (Date.now() - chunkStarted > WALL_CLOCK_BUDGET_MS) {
          budgetExceeded = true;
          break;
        }

        // Touch the heartbeat right before starting real work on this month
        // (which can legitimately take up to FETCH_CALL_TIMEOUT_MS/PER_MONTH_TIMEOUT_MS)
        // — otherwise the external resume-sweep can mistake genuine
        // in-flight work for a stall and fire a duplicate resume mid-month
        // (live-observed: it restarted the current month's fetch a second
        // time while the first was still legitimately paginating).
        await admin.from("prewarm_pl_runs").update({ last_heartbeat_at: new Date().toISOString() }).eq("id", ctx.runId);

        const remainingBudget = WALL_CLOCK_BUDGET_MS - (Date.now() - chunkStarted);
        const fetchTimeoutMs = Math.max(5000, Math.min(FETCH_CALL_TIMEOUT_MS, remainingBudget));
        const abortController = new AbortController();
        const abortTimer = setTimeout(() => abortController.abort(), fetchTimeoutMs);
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
            signal: abortController.signal,
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
          if ((e as Error).name === "AbortError") {
            // The call itself blew through our remaining budget — don't
            // count this as a permanent per-item error, hand off instead so
            // a fresh invocation (with a full budget) can retry this month.
            console.warn(`[prewarm-pl] user=${userId} month=${mkey} fetch_call_timeout`);
            budgetExceeded = true;
            break;
          }
          console.warn(
            `[prewarm-pl] user=${userId} month=${mkey} fetch_error:`,
            (e as Error).message,
          );
          userErrored = true;
          continue;
        } finally {
          clearTimeout(abortTimer);
        }

        if (progressId) {
          const perMonthDeadline = Date.now() + PER_MONTH_TIMEOUT_MS;
          while (Date.now() < perMonthDeadline) {
            // Guard against the *overall* chunk budget too — the per-month
            // 5-minute allowance is meaningless if the real Edge Runtime
            // ceiling (~150s) kills the whole invocation first. Bail out of
            // the wait early and hand off rather than risk a silent kill
            // mid-poll (the exact failure mode found in sync-fnsku-report
            // and full-inventory-refresh-all).
            if (Date.now() - chunkStarted > WALL_CLOCK_BUDGET_MS) {
              budgetExceeded = true;
              break;
            }
            await sleep(4000);
            await admin.from("prewarm_pl_runs").update({ last_heartbeat_at: new Date().toISOString() }).eq("id", ctx.runId);
            const { data: pr } = await admin
              .from("pl_sync_progress")
              .select("status")
              .eq("id", progressId)
              .maybeSingle();
            const status = (pr as any)?.status;
            if (status && status !== "running" && status !== "continue") break;
          }
        }

        if (budgetExceeded) break; // don't count this month yet; re-check freshness on resume

        ctx.totals.monthsRefreshed++;
        console.log(
          `[prewarm-pl] user=${userId} month=${mkey} elapsed_ms=${Date.now() - perMonthStarted}`,
        );

        await sleep(INTER_CALL_DELAY_MS);

        if (Date.now() - chunkStarted > WALL_CLOCK_BUDGET_MS) {
          budgetExceeded = true;
          break;
        }
      }
    } catch (e) {
      console.warn(`[prewarm-pl] user=${userId} error:`, (e as Error).message);
      userErrored = true;
    }

    if (budgetExceeded) {
      // Hand off at the SAME user index — this user's remaining (or
      // in-flight) months will be recomputed as stale on the continuation
      // and picked back up; months already refreshed in this chunk now have
      // a fresh computed_at and will correctly be skipped.
      await handoff(i);
      return;
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
        offset_idx: i + 1,
        last_heartbeat_at: new Date().toISOString(),
      })
      .eq("id", ctx.runId);

    // Continuation gate: if we're close to the wall-clock ceiling AND there
    // are users left, self-invoke and hand off.
    const nextOffset = i + 1;
    if (nextOffset < ctx.userIds.length && Date.now() - chunkStarted > WALL_CLOCK_BUDGET_MS) {
      await handoff(nextOffset);
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
  const bodyOffset: number = Number(body?.offset) || 0;
  // Two ways to trigger a continuation:
  //  - in-band (offset>0 + run_id): the fast path, called by this same
  //    execution right after a handoff.
  //  - external resume (resume:true + run_id, no offset/user_ids needed):
  //    used by an INDEPENDENT execution/trace (a sweep cron) to recover a
  //    stalled run — live-discovered that in-band self-continuation shares
  //    the same execution's outbound-call quota as the work that tripped
  //    it, so it reliably fails right when it's needed most. An external
  //    caller re-derives user_ids/offset from the durable run row instead of
  //    needing them handed in.
  const isInBandContinuation = bodyOffset > 0 && !!body?.run_id;
  const isExternalResume = body?.resume === true && !!body?.run_id;
  const isContinuation = isInBandContinuation || isExternalResume;

  // ---------- Continuation path: skip init, just resume ----------
  if (isContinuation) {
    const { data: runRow } = await admin
      .from("prewarm_pl_runs")
      .select("id, users_processed, months_refreshed, users_errored, user_ids, offset_idx")
      .eq("id", body.run_id)
      .maybeSingle();
    if (!runRow) {
      return new Response(JSON.stringify({ error: "run_id not found" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userIds: string[] = Array.isArray(body.user_ids)
      ? body.user_ids
      : Array.isArray((runRow as any).user_ids)
        ? (runRow as any).user_ids
        : [];
    if (userIds.length === 0) {
      return new Response(JSON.stringify({ error: "user_ids missing" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const offset = isInBandContinuation ? bodyOffset : Number((runRow as any).offset_idx) || 0;

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

  // Persist user_ids + an initial heartbeat so an external sweep can resume
  // this run later without needing anything handed to it in-band.
  await admin
    .from("prewarm_pl_runs")
    .update({ user_ids: userIds, last_heartbeat_at: new Date().toISOString() })
    .eq("id", runId);

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
