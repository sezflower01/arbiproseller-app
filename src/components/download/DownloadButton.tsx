
import React from "react";
import { Button } from "@/components/ui/button";
import { Download, Rocket } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";

interface DownloadButtonProps {
  isDownloading: boolean;
  onClick: () => void;
}

const DownloadButton = ({ isDownloading, onClick }: DownloadButtonProps) => {
  const { t } = useLanguage();

  const handleDownloadClick = () => {
    // Track download button click
    if (typeof gtag !== 'undefined') {
      gtag('event', 'download_click', {
        event_category: 'conversion',
        event_label: 'download_page_main_button',
        value: 1
      });
    }
    onClick();
  };

  return (
    <div className="flex flex-col items-center space-y-4 max-w-2xl mx-auto">
      <div className="flex gap-4 w-full justify-center">
        {/* Main CTA Button */}
        <Button 
          size="lg" 
          className="bg-gradient-to-r from-purple-600 to-blue-500 hover:from-purple-700 hover:to-blue-600 text-white font-medium text-lg px-8 py-6 h-auto relative group transition-all duration-300 shadow-lg hover:shadow-xl"
          onClick={handleDownloadClick}
          disabled={isDownloading}
        >
          {isDownloading ? (
            <>
              <Download className="mr-2 animate-bounce" size={24} />
              {t('download.downloading')}
            </>
          ) : (
            <>
              <Rocket className="mr-2 group-hover:rotate-12 transition-transform" size={24} />
              {t('download.start_free_trial')}
            </>
          )}
        </Button>
      </div>
      
      {/* Supporting text */}
      <div className="text-center space-y-2">
        <p className="text-green-600 font-medium">
          {t('download.full_access')}
        </p>
        <div className="flex justify-center space-x-8 text-sm text-gray-600">
          <span className="flex items-center">
            <Download className="w-4 h-4 mr-1" /> {t('hero.windows_compatible')}
          </span>
          <span>|</span>
          <span className="flex items-center">
            <Rocket className="w-4 h-4 mr-1" /> {t('hero.free_trial_30_days')}
          </span>
        </div>
      </div>
    </div>
  );
};

export default DownloadButton;
