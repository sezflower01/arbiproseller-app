// Fail-closed auth guards for edge functions deployed with verify_jwt=false.
//
// The project standard for internal callers is the `x-internal-secret` header
// carrying the value of the INTERNAL_SYNC_SECRET env var. pg_cron jobs must
// include this header (see the cron.job UPDATE below the plan for the shape).
// Service-role Bearer is also accepted for fanout calls between edge functions.
//
// - requireInternalCall: strict — only accepts internal callers (header OR
//   service_role Bearer). Use for cron-only / fanout-only endpoints.
//
// - requireInternalOrUser: accepts internal callers OR a valid authenticated
//   user JWT (frontend). Rejects the public anon key, missing/malformed
//   Authorization, and unverifiable tokens.
//
// Both close the gap where verify_jwt=false previously allowed any anonymous
// caller (including anyone with the public anon key from the browser bundle).
//
// Usage:
//   if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
//   const forbidden = requireInternalCall(req);          // strict
//   // or: const forbidden = await requireInternalOrUser(req);
//   if (forbidden) return forbidden;

import { createClient } from "npm:@supabase/supabase-js@2";

function forbid(status: number, msg: string): Response {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function isInternalCaller(req: Request): boolean {
  const secret = Deno.env.get("INTERNAL_SYNC_SECRET") ?? "";
  const provided = req.headers.get("x-internal-secret") ?? "";
  if (secret && provided && provided === secret) return true;

  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (serviceKey && bearer === serviceKey) return true;

  return false;
}

export function requireInternalCall(req: Request): Response | null {
  return isInternalCaller(req) ? null : forbid(403, "Forbidden");
}

export async function requireInternalOrUser(req: Request): Promise<Response | null> {
  if (isInternalCaller(req)) return null;

  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");

  if (!bearer) return forbid(401, "Unauthorized");
  // Public anon key alone is NOT a user identity — reject.
  if (anonKey && bearer === anonKey) return forbid(403, "Forbidden");

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  if (!url || !anonKey) return forbid(500, "Server misconfigured");
  const supabase = createClient(url, anonKey);
  try {
    const { data, error } = await supabase.auth.getClaims(bearer);
    if (error || !data?.claims?.sub) return forbid(401, "Unauthorized");
    return null;
  } catch {
    return forbid(401, "Unauthorized");
  }
}
