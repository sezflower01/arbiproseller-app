import { supabase } from "@/integrations/supabase/client";

export interface SettingChangeParams {
  asin: string;
  sku?: string;
  marketplace?: string;
  fieldChanged: string;
  oldValue: number | null;
  newValue: number | null;
  reason?: string;
  source?: string; // 'ui' | 'bulk' | 'retrieve_price' | 'retrieve_roi' | 'set_price' | 'auto_sync'
}

/** Build a rich device fingerprint for audit trail */
function getDeviceInfo(): string {
  try {
    const nav = navigator as any;
    const ua = nav.userAgent || "";

    // --- OS detection with version ---
    let os = nav.platform || "unknown";
    if (ua.includes("Windows NT 10.0")) os = ua.includes("Windows NT 10.0; Win64") ? "Windows 10/11 x64" : "Windows 10/11";
    else if (ua.includes("Windows NT 6.3")) os = "Windows 8.1";
    else if (ua.includes("Windows NT 6.1")) os = "Windows 7";
    else if (ua.includes("Mac OS X")) {
      const m = ua.match(/Mac OS X ([\d_.]+)/);
      os = m ? `macOS ${m[1].replace(/_/g, ".")}` : "macOS";
    } else if (ua.includes("Linux")) os = "Linux";

    // --- Browser + version ---
    let browser = "unknown";
    if (ua.includes("Edg/")) { const m = ua.match(/Edg\/([\d.]+)/); browser = `Edge ${m?.[1] ?? ""}`; }
    else if (ua.includes("OPR/")) { const m = ua.match(/OPR\/([\d.]+)/); browser = `Opera ${m?.[1] ?? ""}`; }
    else if (ua.includes("Chrome/")) { const m = ua.match(/Chrome\/([\d.]+)/); browser = `Chrome ${m?.[1] ?? ""}`; }
    else if (ua.includes("Firefox/")) { const m = ua.match(/Firefox\/([\d.]+)/); browser = `Firefox ${m?.[1] ?? ""}`; }
    else if (ua.includes("Safari/")) { const m = ua.match(/Version\/([\d.]+)/); browser = `Safari ${m?.[1] ?? ""}`; }

    const screenInfo = `${screen.width}x${screen.height}`;

    // --- User-set device nickname (stored in localStorage) ---
    const nickname = localStorage.getItem("device_nickname") || "";

    const parts = nickname ? [nickname, os, browser, screenInfo] : [os, browser, screenInfo];
    return parts.join(" | ");
  } catch {
    return "unknown";
  }
}

/** Allow the user to set/get a device nickname for the audit trail */
export function setDeviceNickname(name: string): void {
  localStorage.setItem("device_nickname", name.trim());
}
export function getDeviceNickname(): string {
  return localStorage.getItem("device_nickname") || "";
}

/**
 * Log a repricer setting change (min/max/price) to the audit table.
 * Fire-and-forget – never blocks the caller.
 */
export async function logSettingChange(params: SettingChangeParams): Promise<void> {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    // Always log — even if value didn't change — so every user action is auditable

    await (supabase as any)
      .from("repricer_setting_changes")
      .insert({
        user_id: user.id,
        asin: params.asin,
        sku: params.sku || null,
        marketplace: params.marketplace || "US",
        field_changed: params.fieldChanged,
        old_value: params.oldValue,
        new_value: params.newValue,
        reason: params.reason || null,
        source: params.source || "ui",
        device_info: getDeviceInfo(),
      });
  } catch (e) {
    console.error("[ChangeLog] Failed to log setting change:", e);
  }
}

/**
 * Log multiple setting changes at once (e.g. bulk updates).
 */
export async function logSettingChanges(changes: SettingChangeParams[]): Promise<void> {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const deviceInfo = getDeviceInfo();
    const rows = changes
      .filter(c => c.oldValue !== c.newValue)
      .map(c => ({
        user_id: user.id,
        asin: c.asin,
        sku: c.sku || null,
        marketplace: c.marketplace || "US",
        field_changed: c.fieldChanged,
        old_value: c.oldValue,
        new_value: c.newValue,
        reason: c.reason || null,
        source: c.source || "ui",
        device_info: deviceInfo,
      }));

    if (rows.length === 0) return;

    await (supabase as any)
      .from("repricer_setting_changes")
      .insert(rows);
  } catch (e) {
    console.error("[ChangeLog] Failed to log bulk setting changes:", e);
  }
}
