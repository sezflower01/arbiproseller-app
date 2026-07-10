
import React, { useEffect } from "react";
import { useDownload } from "@/hooks/use-download";
import DownloadHeader from "./download/DownloadHeader";
import DownloadButton from "./download/DownloadButton";
import VersionInfo from "./download/VersionInfo";
import QuickStartGuide from "./download/QuickStartGuide";
import RequirementsCallout from "./download/RequirementsCallout";
import { Toaster } from "@/components/ui/toaster";
import { useLanguage } from "@/contexts/LanguageContext";

const DownloadSection = () => {
  const { isAttemptingDownload, isDownloading, handleDownload } = useDownload();
  const { t } = useLanguage();
  
  useEffect(() => {
    console.log("DownloadSection component mounted");
  }, []);
  
  return (
    <section id="download-section" className="py-20 bg-gradient-to-b from-purple-50 to-white">
      <div className="container mx-auto px-4">
        <DownloadHeader />
        <RequirementsCallout />
        <DownloadButton 
          isDownloading={isAttemptingDownload || isDownloading} 
          onClick={handleDownload} 
        />
        <VersionInfo />
        <QuickStartGuide />
        <Toaster />
      </div>
    </section>
  );
};

export default DownloadSection;
