// Cross-device usage tracker. Syncs counts via Supabase `module_usage` table
// when the user is signed in; falls back to localStorage when offline/guest.
import { supabase } from "@/integrations/supabase/client";

const STORAGE_KEY = "aps:module_usage_v1";
const EVENT = "aps:module_usage_changed";

export type UsageEntry = { count: number; lastUsed: number; label?: string };
export type UsageMap = Record<string, UsageEntry>;

function readLocal(): UsageMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as UsageMap) : {};
  } catch {
    return {};
  }
}

function writeLocal(map: UsageMap) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
    window.dispatchEvent(new Event(EVENT));
  } catch { /* ignore quota */ }
}

export function getUsage(): UsageMap {
  return readLocal();
}

export function recordUsage(path: string, label?: string) {
  if (!path) return;
  // Optimistic local update for instant UI feedback
  const usage = readLocal();
  const existing = usage[path] ?? { count: 0, lastUsed: 0 };
  usage[path] = {
    count: existing.count + 1,
    lastUsed: Date.now(),
    label: label ?? existing.label,
  };
  writeLocal(usage);

  // Persist to DB (cross-device). Fire and forget.
  void (async () => {
    try {
      await supabase.rpc("record_module_usage", { _path: path, _label: label ?? null });
    } catch { /* offline / signed-out — local copy is fine */ }
  })();
}

export function getTopUsed(limit = 8): Array<{ path: string; count: number; lastUsed: number; label?: string }> {
  const usage = readLocal();
  return Object.entries(usage)
    .map(([path, v]) => ({ path, ...v }))
    .sort((a, b) => b.count - a.count || b.lastUsed - a.lastUsed)
    .slice(0, limit);
}

export function subscribeUsage(cb: () => void): () => void {
  const handler = () => cb();
  window.addEventListener(EVENT, handler);
  window.addEventListener("storage", handler);
  return () => {
    window.removeEventListener(EVENT, handler);
    window.removeEventListener("storage", handler);
  };
}

export async function clearUsage() {
  try {
    localStorage.removeItem(STORAGE_KEY);
    window.dispatchEvent(new Event(EVENT));
  } catch { /* ignore */ }
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      await supabase.from("module_usage").delete().eq("user_id", user.id);
    }
  } catch { /* ignore */ }
}

// Pull the latest counts from Supabase and merge into local cache. Call on
// app boot / login so a fresh device shows the user's existing top modules.
export async function hydrateUsageFromServer(): Promise<void> {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data, error } = await supabase
      .from("module_usage")
      .select("path,label,count,last_used")
      .eq("user_id", user.id);
    if (error || !data) return;

    const local = readLocal();
    const merged: UsageMap = { ...local };
    for (const row of data) {
      const path = row.path as string;
      const serverCount = Number(row.count) || 0;
      const serverLast = row.last_used ? new Date(row.last_used as string).getTime() : 0;
      const cur = merged[path];
      // Server is source of truth across devices — take the higher count.
      if (!cur || serverCount >= cur.count) {
        merged[path] = {
          count: serverCount,
          lastUsed: Math.max(serverLast, cur?.lastUsed ?? 0),
          label: (row.label as string) ?? cur?.label,
        };
      }
    }
    writeLocal(merged);
  } catch { /* ignore */ }
}
