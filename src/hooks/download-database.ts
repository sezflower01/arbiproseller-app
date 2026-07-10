
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

export interface DownloadRecord {
  ip_address: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  user_agent: string;
  file_type: string;
  downloaded_at: string;
}

export async function trackDownloadInDatabase(downloadData: DownloadRecord): Promise<boolean> {
  try {
    console.log("=== DOWNLOAD TRACKING DEBUG ===");
    console.log("Attempting to track download with data:", downloadData);
    console.log("Supabase client status:", supabase ? "Connected" : "Not connected");
    
    // Try direct insert first
    console.log("Attempting direct insert to downloads table...");
    const { data: insertData, error: insertError } = await supabase
      .from("downloads")
      .insert(downloadData)
      .select();

    if (insertError) {
      console.error("❌ Direct insert failed:", insertError);
      console.error("Error details:", {
        message: insertError.message,
        details: insertError.details,
        hint: insertError.hint,
        code: insertError.code
      });
      
      // Try using the edge function as fallback
      console.log("🔄 Trying edge function fallback...");
      const { data: functionData, error: functionError } = await supabase.functions.invoke('insert_download_record', {
        body: downloadData
      });

      if (functionError) {
        console.error("❌ Edge function also failed:", functionError);
        console.error("Function Error details:", {
          message: functionError.message,
          context: functionError.context
        });
        return false;
      } else {
        console.log("✅ Download tracked successfully via edge function");
        console.log("Function Result:", functionData);
        return true;
      }
    } else {
      console.log("✅ Download tracked successfully via direct insert");
      console.log("Insert result:", insertData);
      return true;
    }
  } catch (supabaseError: any) {
    console.error("❌ Unexpected error during download tracking:", supabaseError);
    console.error("Error stack:", supabaseError.stack);
    return false;
  }
}
