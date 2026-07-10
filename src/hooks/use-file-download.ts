
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { fetchGeoInfo, GeoInfo } from "./use-geo-tracking";
import { trackDownloadInDatabase, DownloadRecord } from "./download-database";
import { triggerFileDownload } from "./file-downloader";

export const useFileDownload = () => {
  const [isDownloading, setIsDownloading] = useState(false);
  const { toast } = useToast();

  const downloadFile = async (filePath: string, fileName: string) => {
    try {
      setIsDownloading(true);
      console.log("=== FILE DOWNLOAD PROCESS STARTED ===");
      console.log("[Download] Download requested for:", fileName);
      console.log("[Download] File path:", filePath);

      // Get geo data for analytics
      console.log("[Download] Fetching geo information...");
      const geo: GeoInfo = await fetchGeoInfo();
      console.log("[Download] Geo info retrieved:", geo);

      const timestamp = new Date().toISOString();
      console.log("[Download] Timestamp:", timestamp);

      const downloadData: DownloadRecord = {
        ip_address: geo.ip,
        country: geo.country,
        region: geo.region,
        city: geo.city,
        latitude: geo.latitude,
        longitude: geo.longitude,
        user_agent: navigator.userAgent,
        file_type: 'windows_installer',
        downloaded_at: timestamp,
      };

      console.log("[Download] Prepared download data for database:", downloadData);

      // Track in database BEFORE starting download to ensure we capture the event
      console.log("[Download] Tracking download in database...");
      const trackingSuccess = await trackDownloadInDatabase(downloadData);
      console.log("[Download] Database tracking result:", trackingSuccess);

      // Start the actual file download
      console.log("[Download] Starting file download...");
      const downloadSuccess = await triggerFileDownload(filePath, fileName);

      if (!downloadSuccess) {
        console.error("[Download] File download failed");
        toast({
          title: "Download failed",
          description: "Unable to download the file. Please try again.",
          variant: "destructive",
        });
        return false;
      }

      console.log("[Download] File download successful");
      toast({
        title: "Download started",
        description: "Your file download has been initiated.",
      });

      console.log("=== FILE DOWNLOAD PROCESS COMPLETED SUCCESSFULLY ===");
      return true;
    } catch (error) {
      console.error("=== FILE DOWNLOAD PROCESS FAILED ===");
      console.error("[Download hook] error:", error);
      console.error("Error details:", error);
      toast({
        title: "Download process failed",
        description: "There was a problem with your download. Please try again.",
        variant: "destructive",
      });
      return false;
    } finally {
      setTimeout(() => {
        setIsDownloading(false);
        console.log("[Download] Download state reset");
      }, 2000);
    }
  };

  return { isDownloading, downloadFile };
};
