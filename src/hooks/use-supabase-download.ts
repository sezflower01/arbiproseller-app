
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";

export const useSupabaseDownload = () => {
  const { toast } = useToast();

  const downloadFromStorage = async (bucket: string, path: string) => {
    try {
      // Check if file exists by generating a signed URL with appropriate expiry
      const { data, error } = await supabase
        .storage
        .from(bucket)
        .createSignedUrl(path, 31536000); // 1 year expiry
      
      if (error) {
        console.error("Error checking file existence:", error);
        throw new Error(`File "${path}" not found in storage. Please contact support.`);
      }
      
      if (!data?.signedUrl) {
        throw new Error("Could not generate download URL. The file may not exist.");
      }
      
      // Create a temporary anchor element to open the signed URL in a new tab
      const link = document.createElement('a');
      link.href = data.signedUrl;
      link.download = path.split('/').pop() || path; // Extract filename from path
      link.target = "_blank";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      
      // Show success toast
      toast({
        title: "Download started",
        description: "Your file is downloading. If it doesn't start automatically, check your browser settings.",
      });
      
      return true;
    } catch (error) {
      console.error("Storage download error:", error);
      toast({
        title: "Download failed",
        description: error instanceof Error ? error.message : "There was a problem with your download. Please try again or contact support.",
        variant: "destructive",
      });
      return false;
    }
  };

  return { downloadFromStorage };
};
