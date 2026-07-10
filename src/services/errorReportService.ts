import { supabase } from "@/integrations/supabase/client";

// In-memory dedupe: skip identical (message + path) reports within this window
const DEDUPE_WINDOW_MS = 60_000;
const recentReports = new Map<string, number>();

function pruneOld(now: number) {
  for (const [key, ts] of recentReports) {
    if (now - ts > DEDUPE_WINDOW_MS) recentReports.delete(key);
  }
}

export async function reportError(errorMessage: string, errorContext?: string) {
  try {
    const path = window.location.pathname;
    const key = `${path}::${errorMessage}`;
    const now = Date.now();
    pruneOld(now);
    const last = recentReports.get(key);
    if (last && now - last < DEDUPE_WINDOW_MS) {
      // Same error on same page already reported recently — skip to avoid storms
      return;
    }
    recentReports.set(key, now);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    await supabase.from('error_reports').insert({
      user_id: user.id,
      user_email: user.email || null,
      error_message: errorMessage,
      error_context: errorContext || null,
      page_url: path,
    });
  } catch (e) {
    console.error('Failed to report error:', e);
  }
}
