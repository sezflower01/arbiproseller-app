
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { useFileDownload } from "@/hooks/use-file-download";

export const useDownload = () => {
  const { toast } = useToast();
  const { downloadFile } = useFileDownload(); // Removed isDownloading as it's already in useFileDownload
  const [isAttemptingDownload, setIsAttemptingDownload] = useState(false);
  
  const handleDownload = async () => {
    setIsAttemptingDownload(true);
    try {
      console.log("Starting download process...");
      // Updated direct signed URL with the new token
      const signedUrl = "https://mstibdszibcheodvnprm.supabase.co/storage/v1/object/sign/access/Setup_ArbiProSellerNoAPI.exe?token=eyJraWQiOiJzdG9yYWdlLXVybC1zaWduaW5nLWtleV9iODE0YWYxZi1jYzk3LTQ2MTAtOTc1ZC03ZjY4YWMxNGY1MjQiLCJhbGciOiJIUzI1NiJ9.eyJ1cmwiOiJhY2Nlc3MvU2V0dXBfQXJiaVByb1NlbGxlck5vQVBJLmV4ZSIsImlhdCI6MTc3MTk4ODA4NywiZXhwIjoyMDI0Mjc2MDg3fQ.SwVNAcNtdC3T_Ql0t346UlKJ7yc0EDEsGLufYciaZU4";
      
      // Use the file download service which handles tracking in the database
      const success = await downloadFile(signedUrl, "Setup_ArbiProSellerNoAPI.exe");
      
      if (success) {
        console.log("Download started successfully");
        toast({
          title: "Download started",
          description: "Your installer is downloading. Once complete, run Setup_ArbiProSellerNoAPI.exe to install.",
        });
      }
      
      return success;
    } catch (error) {
      console.error("Download error:", error);
      toast({
        title: "Download failed",
        description: "There was a problem with your download. Please try again or contact support.",
        variant: "destructive",
      });
      return false;
    } finally {
      setIsAttemptingDownload(false);
    }
  };

  // Return isDownloading from useFileDownload directly if needed by consuming components
  // For now, only isAttemptingDownload is specific to this hook's direct operation.
  // The actual isDownloading state is managed within useFileDownload.
  // If DownloadSection or other components need the global isDownloading state,
  // it should be consumed from where useFileDownload is instantiated or passed down.
  // For this hook, we only expose what it directly manages.
  // Update: isDownloading from useFileDownload is now also returned as it might be used
  // by components consuming useDownload to reflect the overall download state.
  const { isDownloading } = useFileDownload();

  return {
    isAttemptingDownload,
    isDownloading,
    handleDownload
  };
};
