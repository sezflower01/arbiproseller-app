import { supabase } from "@/integrations/supabase/client";

/**
 * Triggers automatic onboarding for a single ASIN after cost is added/updated.
 * Runs in the background — errors are logged but don't block the caller.
 */
export async function triggerAutoOnboard(asin: string, sku: string, marketplace = "US") {
  try {
    const { error } = await supabase.functions.invoke("auto-onboard-asin", {
      body: { asin, sku, marketplace },
    });
    if (error) {
      console.warn("[auto-onboard] failed:", error.message);
    }
  } catch (err: any) {
    console.warn("[auto-onboard] error:", err.message);
  }
}
