// Admin-only trigger for the SP-API "Manual Refresh" pipeline.
//
// Reuses `full-inventory-refresh-all` (the exact same per-ASIN rescue logic
// the Manual SP-API Refresh button calls in the browser) but server-side, so
// the target user does NOT need to be logged in.
//
// Safety:
//  1. Caller must have role='admin' in user_roles.
//  2. Refuses to start if `full-inventory-refresh-all` cron lock is held.
//  3. Refuses to start if the scheduled cron `full-inventory-refresh-2h`
//     finished less than ADMIN_REFRESH_COOLDOWN_MIN minutes ago (unless
//     `force: true`).
//  4. Refuses to start if another admin_refresh_run for the same target_user_id
//     is still 'running' and < 30 min old.
//  5. Every attempt — accepted or skipped — is recorded in admin_refresh_runs.
//
// Body: { target_user_id: uuid, source?: 'manual' | 'self_auto', force?: bool }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ADMIN_REFRESH_COOLDOWN_MIN = 10; // wait 10 min after cron finishes
const RUNNING_RUN_STALE_MIN = 30;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const INTERNAL_SECRET = Deno.env.get("INTERNAL_SYNC_SECRET") || "";
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

  // --- Auth: identify caller from JWT ---
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "Missing bearer" }, 401);

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userRes, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userRes?.user) return json({ error: "Invalid session" }, 401);
  const caller = userRes.user;

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  // --- Auth: caller must be admin ---
  const { data: isAdmin, error: roleErr } = await admin.rpc("has_role", {
    _user_id: caller.id,
    _role: "admin",
  });
  if (roleErr) return json({ error: `Role check failed: ${roleErr.message}` }, 500);
  if (!isAdmin) return json({ error: "Forbidden — admin only" }, 403);

  // --- Parse body ---
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const targetUserId: string | undefined = body?.target_user_id;
  const allowedSources = new Set(["self_auto", "manual", "manual_self", "manual_chain", "manual_all"]);
  const source: string = allowedSources.has(body?.source) ? body.source : "manual";
  const force: boolean = body?.force === true;
  const auditOnly: boolean = body?.audit_only === true;
  const auditStatus: string = body?.audit_status === "failed" ? "failed" : "success";
  const auditStartedAt: string | null = typeof body?.started_at === "string" ? body.started_at : null;
  const auditErrorMessage: string | null = typeof body?.error_message === "string" ? body.error_message.slice(0, 400) : null;
  if (!targetUserId || typeof targetUserId !== "string") {
    return json({ error: "target_user_id required" }, 400);
  }
  const scope = targetUserId === caller.id ? "self" : "single_user";

  // --- Audit-only short-circuit: record a completed row, skip all guards/dispatch.
  // Used by the UI to log Manual SP-API Refresh clicks (which run in the browser
  // and don't otherwise touch admin_refresh_runs).
  if (auditOnly) {
    const [{ data: cp }, { data: tp }] = await Promise.all([
      admin.from("profiles").select("email").eq("id", caller.id).maybeSingle(),
      admin.from("profiles").select("email").eq("id", targetUserId).maybeSingle(),
    ]);
    const { data, error } = await admin
      .from("admin_refresh_runs")
      .insert({
        triggered_by_user_id: caller.id,
        triggered_by_email: cp?.email ?? null,
        target_user_id: targetUserId,
        target_email: tp?.email ?? null,
        scope,
        source,
        status: auditStatus,
        started_at: auditStartedAt ?? new Date().toISOString(),
        completed_at: new Date().toISOString(),
        error_message: auditErrorMessage,
        detail: { audit_only: true },
      })
      .select("id")
      .single();
    if (error) return json({ error: `audit insert failed: ${error.message}` }, 500);
    return json({ accepted: true, audit_only: true, run_id: data?.id }, 200);
  }

  // --- Resolve emails for audit ---
  const [{ data: callerProfile }, { data: targetProfile }] = await Promise.all([
    admin.from("profiles").select("email").eq("id", caller.id).maybeSingle(),
    admin.from("profiles").select("email").eq("id", targetUserId).maybeSingle(),
  ]);

  const recordRun = async (
    status: string,
    extras: Record<string, unknown> = {},
  ): Promise<{ id?: string; duplicate?: boolean }> => {
    const { data, error } = await admin
      .from("admin_refresh_runs")
      .insert({
        triggered_by_user_id: caller.id,
        triggered_by_email: callerProfile?.email ?? null,
        target_user_id: targetUserId,
        target_email: targetProfile?.email ?? null,
        scope,
        source,
        status,
        completed_at: status === "running" ? null : new Date().toISOString(),
        ...extras,
      })
      .select("id")
      .single();
    if (error) {
      // 23505 = unique_violation from the partial unique index
      // `admin_refresh_runs_one_running_per_user`: another run is already
      // status='running' for this target_user_id. Treat as a clean skip.
      if ((error as any).code === "23505" && status === "running") {
        return { duplicate: true };
      }
      console.warn(`[admin-trigger-refresh] audit insert failed: ${error.message}`);
    }
    return { id: data?.id as string | undefined };
  };

  // --- Guard 1: another admin run already running for same target? ---
  const staleCutoff = new Date(Date.now() - RUNNING_RUN_STALE_MIN * 60_000).toISOString();
  const { data: existingRun } = await admin
    .from("admin_refresh_runs")
    .select("id, started_at")
    .eq("target_user_id", targetUserId)
    .eq("status", "running")
    .gt("started_at", staleCutoff)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existingRun) {
    await recordRun("skipped_locked", {
      skipped_reason: `another admin refresh for this user started ${existingRun.started_at}`,
    });
    return json({
      accepted: false,
      reason: "another_admin_refresh_running",
      since: existingRun.started_at,
    }, 409);
  }

  // --- Guard 2: scheduled cron recently completed? ---
  if (!force) {
    const cooldownCutoff = new Date(
      Date.now() - ADMIN_REFRESH_COOLDOWN_MIN * 60_000,
    ).toISOString();
    const { data: recentCron } = await admin
      .from("cron_run_history")
      .select("started_at, completed_at, status")
      .eq("job_name", "full-inventory-refresh-all")
      .gt("started_at", cooldownCutoff)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (recentCron) {
      await recordRun("skipped_cron_recent", {
        skipped_reason: `scheduled cron ran at ${recentCron.started_at} (status=${recentCron.status}); cooldown ${ADMIN_REFRESH_COOLDOWN_MIN}min`,
        detail: { recent_cron: recentCron },
      });
      return json({
        accepted: false,
        reason: "cron_recently_ran",
        cron_started_at: recentCron.started_at,
        cooldown_min: ADMIN_REFRESH_COOLDOWN_MIN,
      }, 429);
    }
  }

  // --- Guard 3: scheduled cron currently holding its lock? ---
  const { data: lockHeld } = await admin
    .from("cron_run_locks")
    .select("job_name, acquired_at, expires_at")
    .eq("job_name", "full-inventory-refresh-all")
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (lockHeld) {
    await recordRun("skipped_locked", {
      skipped_reason: `cron lock held until ${lockHeld.expires_at}`,
      detail: { lock: lockHeld },
    });
    return json({
      accepted: false,
      reason: "cron_lock_held",
      lock: lockHeld,
    }, 409);
  }

  // --- All clear: record running row, then invoke fan-out ---
  const runInsert = await recordRun("running");

  // Race-proof: if the DB-level partial unique index rejected our INSERT,
  // another tab/computer beat us by milliseconds. Return clean skipped_locked.
  if (runInsert.duplicate) {
    await recordRun("skipped_locked", {
      skipped_reason: "unique_violation: another admin refresh already running (DB-level dedup)",
    });
    return json({
      accepted: false,
      reason: "another_admin_refresh_running",
      detail: "db_unique_index_blocked_duplicate_insert",
    }, 409);
  }

  const runId = runInsert.id;

  // Fire-and-forget invocation of full-inventory-refresh-all with target user.
  // We do NOT await its full completion (it can run for minutes). Instead we
  // dispatch and rely on the audit row + the function's own logs.
  const dispatchPromise = (async () => {
    const t0 = Date.now();
    try {
      const resp = await fetch(
        `${SUPABASE_URL}/functions/v1/full-inventory-refresh-all`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${SERVICE_KEY}`,
            "x-internal-secret": INTERNAL_SECRET,
          },
          body: JSON.stringify({ user_id: targetUserId }),
        },
      );
      const text = await resp.text();
      const elapsed = Date.now() - t0;
      if (runId) {
        await admin
          .from("admin_refresh_runs")
          .update({
            status: resp.ok ? "success" : "failed",
            completed_at: new Date().toISOString(),
            error_message: resp.ok ? null : `HTTP ${resp.status}: ${text.slice(0, 400)}`,
            detail: { dispatch_status: resp.status, elapsed_ms: elapsed },
          })
          .eq("id", runId);
      }
    } catch (e: any) {
      if (runId) {
        await admin
          .from("admin_refresh_runs")
          .update({
            status: "failed",
            completed_at: new Date().toISOString(),
            error_message: String(e?.message || e).slice(0, 400),
          })
          .eq("id", runId);
      }
    }
  })();

  // @ts-ignore - EdgeRuntime is Supabase global
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(dispatchPromise);

  return json({
    accepted: true,
    run_id: runId,
    scope,
    source,
    target_user_id: targetUserId,
  }, 202);
});
