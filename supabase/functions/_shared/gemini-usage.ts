// Gemini call outcomes, recorded so a quota outage is visible rather than
// silently degrading results.
//
// Every Gemini call site used to do `if (!resp.ok) return null;`. A 429 and
// "the model had no opinion" produced the same value, so an exhausted quota
// showed up as weaker match confidence and a reason string reading "Based on
// text match only" -- with nothing anywhere saying the AI had not run.
//
// This is observation only. It gates nothing and changes no behaviour on its
// own; callers decide what to do with the outcome.

/** Why a Gemini call produced no verdict. */
export type GeminiFailureKind = 'quota' | 'http' | 'network' | 'malformed';

export interface GeminiFailure {
  kind: GeminiFailureKind;
  status?: number;
  /** Safe to show a user. Quota is temporary and says so. */
  message: string;
}

export function classifyGeminiFailure(status: number | undefined, detail?: string): GeminiFailure {
  if (status === 429) {
    return { kind: 'quota', status, message: 'AI quota exhausted — try again shortly' };
  }
  if (status === 401 || status === 403) {
    return { kind: 'http', status, message: 'AI key rejected' };
  }
  if (typeof status === 'number') {
    return { kind: 'http', status, message: `AI unavailable (HTTP ${status})` };
  }
  return { kind: 'network', message: detail ? `AI unreachable: ${detail}` : 'AI unreachable' };
}

/**
 * Record one call. Never throws -- observability must not be able to break the
 * thing it observes.
 *
 * `supabase` may be null for call sites that have no client to hand; the log
 * line still goes out, which is strictly better than today's silence.
 */
export async function recordGeminiCall(
  supabase: unknown,
  ok: boolean,
  status: number | undefined,
  caller: string,
): Promise<void> {
  if (!ok) {
    console.warn(
      `[gemini] call failed caller=${caller} status=${status ?? 'none'} at ${new Date().toISOString()}`,
    );
  }
  const client = supabase as { rpc?: (n: string, p: Record<string, unknown>) => Promise<{ error: unknown }> } | null;
  if (!client?.rpc) return;
  try {
    await client.rpc('record_gemini_call', {
      p_ok: ok,
      p_status: typeof status === 'number' ? status : null,
      p_caller: caller,
    });
  } catch (e) {
    console.warn('[gemini] failed to record call:', (e as Error).message);
  }
}
