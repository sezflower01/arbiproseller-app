// Periodic SP-API health monitor.
// Every cron tick: tests stored credentials for every user, classifies failures,
// and emails sezflower01@gmail.com immediately when an auth/secret/refresh-token
// issue is detected. Recoveries are also reported.
//
// Triggers: pg_cron every 15 minutes + on-demand POST.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { raiseSpapiAlert, resolveSpapiAlerts, classifySpapiError } from "../_shared/spapi-alert.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SP_API_HOSTS: Record<string, string> = {
  na: "https://sellingpartnerapi-na.amazon.com",
  eu: "https://sellingpartnerapi-eu.amazon.com",
  fe: "https://sellingpartnerapi-fe.amazon.com",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function getLWAToken(refreshToken: string, clientId: string, clientSecret: string) {
  const r = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  const text = await r.text();
  if (!r.ok) {
    let parsed: any = {};
    try { parsed = JSON.parse(text); } catch {}
    throw new Error(parsed?.error || parsed?.error_description || `LWA ${r.status}: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text).access_token as string;
}

async function pingSellersApi(accessToken: string, region: string) {
  const host = SP_API_HOSTS[region] ?? SP_API_HOSTS.na;
  const r = await fetch(`${host}/sellers/v1/marketplaceParticipations`, {
    headers: { "x-amz-access-token": accessToken, "Content-Type": "application/json" },
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Sellers API ${r.status}: ${text.slice(0, 300)}`);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);

    // Get every user with stored SP-API credentials
    const { data: rows, error: rowErr } = await admin
      .from("user_spapi_credentials")
      .select("user_id, region");
    if (rowErr) return json({ error: rowErr.message }, 500);

    const results: Array<{ user_id: string; status: string; issue?: string }> = [];

    for (const row of rows ?? []) {
      const userId = row.user_id as string;

      // Look up email for nicer alerts
      let userEmail: string | null = null;
      try {
        const { data: u } = await admin.auth.admin.getUserById(userId);
        userEmail = u?.user?.email ?? null;
      } catch { /* ignore */ }

      // Decrypt
      const { data: dec, error: decErr } = await admin.rpc(
        "get_spapi_credentials_decrypted",
        { p_user_id: userId },
      );
      if (decErr) {
        await raiseSpapiAlert({
          userId,
          userEmail,
          errorMessage: `decrypt failed: ${decErr.message}`,
          source: "monitor-spapi-health",
        });
        results.push({ user_id: userId, status: "error", issue: "decrypt_failed" });
        continue;
      }

      const c = (dec as any[])?.[0];
      if (!c?.lwa_client_id || !c?.lwa_client_secret || !c?.refresh_token) {
        await raiseSpapiAlert({
          userId,
          userEmail,
          errorMessage: "Missing credentials — Client ID, Secret, or Refresh Token is not stored.",
          source: "monitor-spapi-health",
        });
        results.push({ user_id: userId, status: "error", issue: "missing_credentials" });
        continue;
      }

      try {
        const tok = await getLWAToken(c.refresh_token, c.lwa_client_id, c.lwa_client_secret);
        await pingSellersApi(tok, c.region || row.region || "na");

        // Success → record + resolve any open alerts
        await admin.rpc("record_spapi_test_result", {
          p_user_id: userId,
          p_status: "ok",
          p_error: null,
          p_seller_id: null,
          p_marketplaces: null,
        });
        await resolveSpapiAlerts({ userId, userEmail });
        results.push({ user_id: userId, status: "ok" });
      } catch (e: any) {
        const msg = String(e?.message || e);
        await admin.rpc("record_spapi_test_result", {
          p_user_id: userId,
          p_status: "error",
          p_error: msg,
          p_seller_id: null,
          p_marketplaces: null,
        });
        await raiseSpapiAlert({
          userId,
          userEmail,
          errorMessage: msg,
          source: "monitor-spapi-health",
        });
        results.push({ user_id: userId, status: "error", issue: classifySpapiError(msg) });
      }
    }

    return json({ ok: true, checked: results.length, results });
  } catch (e: any) {
    console.error("[monitor-spapi-health] fatal:", e);
    return json({ error: String(e?.message || e) }, 500);
  }
});
