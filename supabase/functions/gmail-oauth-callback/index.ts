// Handles Google's OAuth redirect: exchanges code for tokens, stores them, and redirects user back.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const REDIRECT_URI =
  "https://mstibdszibcheodvnprm.supabase.co/functions/v1/gmail-oauth-callback";
const APP_RETURN = "https://arbiproseller.com/tools/email-center";

function html(message: string, ok: boolean) {
  return `<!doctype html><meta charset="utf-8"><title>Gmail Connection</title>
<style>body{font-family:system-ui;background:#0f1c3f;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{background:#1a2a55;padding:32px 40px;border-radius:12px;text-align:center;max-width:480px}
a{color:#60a5fa}</style>
<div class="card"><h2>${ok ? "✅ Gmail Connected" : "❌ Connection Failed"}</h2>
<p>${message}</p>
<p><a href="${APP_RETURN}">Return to Email Center</a></p>
<script>setTimeout(()=>{location.href=${JSON.stringify(APP_RETURN)}},2000)</script></div>`;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errParam = url.searchParams.get("error");

  if (errParam) {
    return new Response(html(`Google returned: ${errParam}`, false), {
      status: 400,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
  if (!code || !state) {
    return new Response(html("Missing code or state.", false), {
      status: 400,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  try {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: stateRow, error: stateErr } = await admin
      .from("gmail_oauth_states")
      .select("user_id")
      .eq("state", state)
      .maybeSingle();
    if (stateErr || !stateRow) throw new Error("Invalid or expired state");
    const userId = stateRow.user_id;
    await admin.from("gmail_oauth_states").delete().eq("state", state);

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: Deno.env.get("GOOGLE_OAUTH_CLIENT_ID")!,
        client_secret: Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET")!,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
      }),
    });
    const tokenJson = await tokenRes.json();
    console.log("[gmail-oauth-callback] token exchange status:", tokenRes.status, "scopes:", tokenJson.scope);
    if (!tokenRes.ok) throw new Error(tokenJson.error_description || tokenJson.error || "Token exchange failed");

    const { access_token, refresh_token, expires_in, scope } = tokenJson;
    if (!access_token) throw new Error("No access_token returned from Google");
    if (!refresh_token) {
      throw new Error("No refresh token returned. Revoke app at myaccount.google.com/permissions and retry.");
    }

    const grantedScopes = (scope || "").split(" ");
    if (!grantedScopes.includes("https://www.googleapis.com/auth/gmail.readonly")) {
      throw new Error(`gmail.readonly scope NOT granted. Granted scopes: ${scope || "(none)"}.`);
    }

    let email: string | null = null;
    const profileRes = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      { headers: { Authorization: `Bearer ${access_token}` } },
    );
    const profileText = await profileRes.text();
    if (profileRes.ok) {
      try { email = JSON.parse(profileText).emailAddress ?? null; } catch { /* ignore */ }
    }

    if (!email) {
      const uiRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
        headers: { Authorization: `Bearer ${access_token}` },
      });
      const uiText = await uiRes.text();
      if (uiRes.ok) {
        try { email = JSON.parse(uiText).email ?? null; } catch { /* ignore */ }
      }
    }

    if (!email) {
      throw new Error(`Could not fetch Gmail profile. HTTP ${profileRes.status} — ${profileText.slice(0, 300)}`);
    }

    const expiresAt = new Date(Date.now() + (expires_in - 60) * 1000).toISOString();

    // Upsert by (user_id, email) so users can connect multiple Gmail accounts
    await admin.from("gmail_connections").upsert(
      {
        user_id: userId,
        email,
        access_token,
        refresh_token,
        token_expires_at: expiresAt,
        scope,
      },
      { onConflict: "user_id,email" },
    );

    return new Response(html(`Connected ${email}. Redirecting...`, true), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  } catch (e) {
    return new Response(html(String((e as Error).message || e), false), {
      status: 500,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
});
