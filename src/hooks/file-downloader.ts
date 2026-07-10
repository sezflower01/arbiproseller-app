
import { toast } from "@/hooks/use-toast";

export async function triggerFileDownload(filePath: string, fileName: string): Promise<boolean> {
  try {
    console.log("[Download] Starting download process for:", filePath);
    
    const link = document.createElement('a');
    link.href = filePath;
    link.download = fileName;
    link.target = "_blank";
    document.body.appendChild(link);
    console.log("[Download] Clicking download link for:", filePath);
    link.click();
    document.body.removeChild(link);

    console.log("[Download] Download link clicked successfully");
    toast({
      title: "Download started",
      description: "Your file download has been initiated.",
    });
    return true;
  } catch (downloadError) {
    console.error("[Download] File download error:", downloadError);
    toast({
      title: "Download failed",
      description: "Unable to start your download. Please try again.",
      variant: "destructive",
    });
    return false;
  }
}
