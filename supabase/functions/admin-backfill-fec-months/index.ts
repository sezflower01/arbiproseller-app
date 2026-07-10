// Admin-only one-shot backfill of financial_events_cache for a given user
// across a list of YYYY-MM month keys. Calls fetch-profit-loss in service-role
// mode (which already supports { user_id } + Bearer SERVICE_ROLE_KEY) once per
// month, waits for the upstream call to complete, then verifies FEC row count
// per month and reports a per-month summary.
//
// Body:
//   { target_user_id: string, months: string[]  e.g. ["2026-01","2026-02"], force?: boolean }
//
// Auth: caller MUST be an admin (user_roles.role = 'admin').

import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return new Response(JSON.stringify({ error: "Missing auth" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Identify caller and assert admin.
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const admin = createClient(supabaseUrl, serviceKey);
  const { data: roleRow } = await admin
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .eq("role", "admin")
    .maybeSingle();
  if (!roleRow) {
    return new Response(JSON.stringify({ error: "Admin only" }), {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let body: any = {};
  try {
    body = await req.json();
  } catch {}
  const action: string = body.action || "run";
  const targetUserId: string = body.target_user_id;
  const months: string[] = Array.isArray(body.months) ? body.months : [];
  const month: string | undefined = body.month;
  const progressId: string | undefined = body.progress_id;
  const force: boolean = body.force === true;
  if (!targetUserId || (action === "run" && months.length === 0) || (action !== "run" && !month)) {
    return new Response(
      JSON.stringify({ error: "target_user_id and month/months[] required" }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  const monthRange = (mkey: string) => {
    const [yStr, mStr] = mkey.split("-");
    const y = Number(yStr);
    const m = Number(mStr);
    if (!y || !m || m < 1 || m > 12) return null;
    const mstart = `${y}-${String(m).padStart(2, "0")}-01`;
    const lastDay = new Date(y, m, 0).getDate();
    const mend = `${y}-${String(m).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
    return { mstart, mend };
  };

  if (action === "status") {
    const range = monthRange(month!);
    if (!range || !progressId) {
      return new Response(JSON.stringify({ error: "valid month and progress_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: progress } = await admin
      .from("pl_sync_progress")
      .select("id, user_id, status, message, error, current_chunk, total_chunks, updated_at")
      .eq("id", progressId)
      .eq("user_id", targetUserId)
      .maybeSingle();

    const { count: fecCount } = await admin
      .from("financial_events_cache")
      .select("id", { count: "exact", head: true })
      .eq("user_id", targetUserId)
      .gte("event_date", range.mstart)
      .lte("event_date", range.mend);

    // If the progress row vanished (another fetch-profit-loss invocation —
    // e.g. the regular current-month auto-sync — deleted it), the backfill
    // may STILL be writing rows in the background. Only treat "progress
    // missing" as done when FEC rows have actually landed. Otherwise keep
    // polling — the client tracks the overall deadline.
    const progressMissing = !progress;
    const status = progress?.status || (progressMissing ? "progress_missing" : "unknown");
    const fec = fecCount || 0;
    const terminalProgress = status === "completed" || status === "error";
    const done = terminalProgress || (progressMissing && fec > 0);
    const ok = fec > 0 && status !== "error";

    if (done) {
      await admin.from("historical_sync_checkpoints").upsert(
        {
          user_id: targetUserId,
          sync_type: "settled",
          month_key: month,
          status: ok ? "done" : "error",
          completed_at: new Date().toISOString(),
          error_message: ok ? null : `progress=${status} fec_rows=${fec} ${progress?.error || progress?.message || ""}`,
          orders_processed: fec,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,sync_type,month_key" },
      );
    }

    return new Response(JSON.stringify({
      month,
      progress_id: progressId,
      progress_status: status,
      message: progress?.message || null,
      error: progress?.error || null,
      current_chunk: progress?.current_chunk || null,
      total_chunks: progress?.total_chunks || null,
      updated_at: progress?.updated_at || null,
      fec_rows: fecCount ?? 0,
      done,
      ok,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (action === "start_month") {
    const range = monthRange(month!);
    if (!range) {
      return new Response(JSON.stringify({ error: "bad month key" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    await admin.from("historical_sync_checkpoints").upsert(
      {
        user_id: targetUserId,
        sync_type: "settled",
        month_key: month,
        status: "running",
        started_at: new Date().toISOString(),
        completed_at: null,
        error_message: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,sync_type,month_key" },
    );

    const startedAt = Date.now();
    const r = await fetch(`${supabaseUrl}/functions/v1/fetch-profit-loss`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceKey}`,
        apikey: serviceKey,
      },
      body: JSON.stringify({
        user_id: targetUserId,
        startDate: `${range.mstart}T00:00:00.000Z`,
        endDate: `${range.mend}T23:59:59.999Z`,
        forceRefresh: force,
      }),
    });
    const upstreamBody = await r.text();
    let parsed: any = null;
    try { parsed = JSON.parse(upstreamBody); } catch {}

    if (!r.ok || !parsed?.progressId) {
      await admin.from("historical_sync_checkpoints").upsert(
        {
          user_id: targetUserId,
          sync_type: "settled",
          month_key: month,
          status: "error",
          completed_at: new Date().toISOString(),
          error_message: `upstream=${r.status} ${upstreamBody.slice(0, 300)}`,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,sync_type,month_key" },
      );
      return new Response(JSON.stringify({ error: "Failed to start month", upstream_status: r.status, upstream_body: upstreamBody.slice(0, 500) }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({
      month,
      progress_id: parsed.progressId,
      upstream_status: r.status,
      elapsed_ms: Date.now() - startedAt,
      started: true,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const results: Array<Record<string, unknown>> = [];

  for (const mkey of months) {
    const range = monthRange(mkey);
    if (!range) {
      results.push({ month: mkey, status: "error", error: "bad month key" });
      continue;
    }

    // Mark running
    await admin.from("historical_sync_checkpoints").upsert(
      {
        user_id: targetUserId,
        sync_type: "settled",
        month_key: mkey,
        status: "running",
        started_at: new Date().toISOString(),
        completed_at: null,
        error_message: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,sync_type,month_key" },
    );

    const startedAt = Date.now();
    let upstreamStatus = 0;
    let upstreamBody = "";
    try {
      const r = await fetch(`${supabaseUrl}/functions/v1/fetch-profit-loss`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${serviceKey}`,
          apikey: serviceKey,
        },
        body: JSON.stringify({
          user_id: targetUserId,
          startDate: `${range.mstart}T00:00:00.000Z`,
          endDate: `${range.mend}T23:59:59.999Z`,
          forceRefresh: force,
        }),
      });
      upstreamStatus = r.status;
      upstreamBody = await r.text();
    } catch (e: any) {
      upstreamBody = e?.message || String(e);
    }

    // If fetch-profit-loss kicked off a progress record, poll until terminal.
    let progressId: string | null = null;
    try {
      progressId = JSON.parse(upstreamBody)?.progressId || null;
    } catch {}
    if (progressId) {
      const deadline = Date.now() + 5 * 60_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 4000));
        const { data: pr } = await admin
          .from("pl_sync_progress")
          .select("status, message")
          .eq("id", progressId)
          .maybeSingle();
        if (pr?.status && pr.status !== "running" && pr.status !== "continue") {
          break;
        }
      }
    }

    // Verify FEC rows were written.
    const { count: fecCount } = await admin
      .from("financial_events_cache")
      .select("id", { count: "exact", head: true })
      .eq("user_id", targetUserId)
      .gte("event_date", range.mstart)
      .lte("event_date", range.mend);

    const ok = upstreamStatus >= 200 && upstreamStatus < 300 && (fecCount || 0) > 0;
    await admin.from("historical_sync_checkpoints").upsert(
      {
        user_id: targetUserId,
        sync_type: "settled",
        month_key: mkey,
        status: ok ? "done" : "error",
        completed_at: new Date().toISOString(),
        error_message: ok
          ? null
          : `upstream=${upstreamStatus} fec_rows=${fecCount ?? 0} ${upstreamBody.slice(0, 300)}`,
        orders_processed: fecCount ?? 0,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,sync_type,month_key" },
    );

    results.push({
      month: mkey,
      upstream_status: upstreamStatus,
      fec_rows: fecCount ?? 0,
      elapsed_ms: Date.now() - startedAt,
      ok,
    });
  }

  return new Response(JSON.stringify({ target_user_id: targetUserId, results }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
