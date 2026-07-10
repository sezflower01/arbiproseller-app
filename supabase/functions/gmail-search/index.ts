// Searches the user's Gmail with a query keyword and returns parsed messages with HTML body.
// Supports multiple connected Gmail accounts: pass `email` to target one, or omit to search all.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

async function refreshAccessToken(refreshToken: string) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_OAUTH_CLIENT_ID")!,
      client_secret: Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET")!,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error_description || "Refresh failed");
  return json as { access_token: string; expires_in: number };
}

function decodeBase64Url(data: string): string {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  try {
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return "";
  }
}

interface Part {
  mimeType?: string;
  body?: { data?: string; attachmentId?: string; size?: number };
  filename?: string;
  parts?: Part[];
  headers?: Array<{ name: string; value: string }>;
}

function extractBody(payload: Part): { html: string; text: string; attachments: Array<{ filename: string; mimeType: string; attachmentId: string; size: number }> } {
  let html = "";
  let text = "";
  const attachments: Array<{ filename: string; mimeType: string; attachmentId: string; size: number }> = [];
  function walk(part: Part) {
    if (!part) return;
    if (part.filename && part.body?.attachmentId) {
      attachments.push({
        filename: part.filename,
        mimeType: part.mimeType || "application/octet-stream",
        attachmentId: part.body.attachmentId,
        size: part.body.size || 0,
      });
    }
    if (part.mimeType === "text/html" && part.body?.data) html += decodeBase64Url(part.body.data);
    else if (part.mimeType === "text/plain" && part.body?.data) text += decodeBase64Url(part.body.data);
    if (part.parts) part.parts.forEach(walk);
  }
  walk(payload);
  return { html, text, attachments };
}

function getHeader(headers: Array<{ name: string; value: string }> | undefined, name: string): string {
  if (!headers) return "";
  const h = headers.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value || "";
}

async function searchOne(conn: any, admin: any, q: string, maxResults: number, pageToken: string) {
  let accessToken = conn.access_token;
  if (new Date(conn.token_expires_at).getTime() < Date.now()) {
    const refreshed = await refreshAccessToken(conn.refresh_token);
    accessToken = refreshed.access_token;
    await admin.from("gmail_connections").update({
      access_token: accessToken,
      token_expires_at: new Date(Date.now() + (refreshed.expires_in - 60) * 1000).toISOString(),
    }).eq("user_id", conn.user_id).eq("email", conn.email);
  }

  const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  listUrl.searchParams.set("maxResults", String(maxResults));
  if (q) listUrl.searchParams.set("q", q);
  if (pageToken) listUrl.searchParams.set("pageToken", pageToken);

  const listRes = await fetch(listUrl.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const listJson = await listRes.json();
  if (!listRes.ok) {
    throw new Error(listJson.error?.message || "Gmail list failed");
  }
  const ids: Array<{ id: string }> = listJson.messages || [];
  const messages = await Promise.all(ids.map(async ({ id }) => {
    const r = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    const m = await r.json();
    const headers = m.payload?.headers || [];
    const { html, text, attachments } = extractBody(m.payload || {});
    return {
      id: m.id,
      threadId: m.threadId,
      snippet: m.snippet,
      subject: getHeader(headers, "Subject"),
      from: getHeader(headers, "From"),
      to: getHeader(headers, "To"),
      date: getHeader(headers, "Date"),
      internalDate: m.internalDate,
      html,
      text,
      attachments,
      labelIds: m.labelIds || [],
      account: conn.email,
    };
  }));
  return { messages, nextPageToken: listJson.nextPageToken || null };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing auth" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    const keyword: string = (body.keyword || "").toString().trim();
    const maxResults: number = Math.min(Math.max(parseInt(body.maxResults) || 100, 1), 100);
    const pageToken: string = (body.pageToken || "").toString();
    const accountEmail: string | null = body.email ? String(body.email) : null;

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    let connQuery = admin.from("gmail_connections").select("*").eq("user_id", userData.user.id);
    if (accountEmail) connQuery = connQuery.eq("email", accountEmail);
    const { data: conns, error: connErr } = await connQuery;
    if (connErr || !conns || conns.length === 0) {
      return new Response(JSON.stringify({ error: "NOT_CONNECTED" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const q = keyword || "";

    // Single account (or specific email): paginate normally
    if (accountEmail || conns.length === 1) {
      const { messages, nextPageToken } = await searchOne(conns[0], admin, q, maxResults, pageToken);
      return new Response(JSON.stringify({
        email: conns[0].email,
        query: q,
        total: messages.length,
        messages,
        nextPageToken,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Multiple accounts (All): fan out, no pagination across accounts (first page each, merged + sorted)
    const results = await Promise.allSettled(
      conns.map((c) => searchOne(c, admin, q, maxResults, "")),
    );
    const merged: any[] = [];
    const errors: Array<{ email: string; error: string }> = [];
    results.forEach((r, i) => {
      if (r.status === "fulfilled") merged.push(...r.value.messages);
      else errors.push({ email: conns[i].email, error: String(r.reason?.message || r.reason) });
    });
    merged.sort((a, b) => Number(b.internalDate || 0) - Number(a.internalDate || 0));

    return new Response(JSON.stringify({
      email: "ALL",
      query: q,
      total: merged.length,
      messages: merged,
      nextPageToken: null,
      errors: errors.length ? errors : undefined,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error).message || e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
