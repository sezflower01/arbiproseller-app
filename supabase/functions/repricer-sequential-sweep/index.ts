import { requireInternalOrUser } from '../_shared/require-internal.ts';
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function isLegacyAnonCronCall(req: Request): boolean {
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  return Boolean(anonKey && bearer === anonKey && !req.headers.get("x-internal-secret"));
}

/**
 * DEPRECATED — replaced by repricer-unified-dispatch
 * This function is kept as a no-op because the pg_cron job (owned by a
 * different DB role) cannot be deleted. It returns immediately with no
 * API calls, no DB writes, and no side-effects.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (isLegacyAnonCronCall(req)) {
    console.log("[sweep] Legacy anon cron call ignored; unified-dispatch handles this job.");
    return new Response(JSON.stringify({ success: true, deprecated: true, ignored_legacy_anon_cron: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const __forbidden = await requireInternalOrUser(req);
  if (__forbidden) return __forbidden;


  console.log("[sweep] DEPRECATED — unified-dispatch is now the sole dispatcher. No-op.");

  return new Response(
    JSON.stringify({ success: true, deprecated: true, message: "Replaced by repricer-unified-dispatch" }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
