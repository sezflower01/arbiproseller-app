
import React from "react";
import { ArrowDown, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDownload } from "@/hooks/use-download";
import { useLanguage } from "@/contexts/LanguageContext";

const DownloadHero = () => {
  const { isAttemptingDownload, isDownloading, handleDownload } = useDownload();
  const { t } = useLanguage();

  // Function to scroll to the download section
  const scrollToDownload = () => {
    const downloadSection = document.getElementById('download-section');
    if (downloadSection) {
      downloadSection.scrollIntoView({ behavior: 'smooth' });
    }
  };

  const handleDownloadClick = () => {
    // Track download button click
    if (typeof gtag !== 'undefined') {
      gtag('event', 'download_click', {
        event_category: 'conversion',
        event_label: 'download_hero_main_button',
        value: 1
      });
    }
    handleDownload();
  };

  return (
    <section className="relative min-h-[70vh] flex items-center overflow-hidden bg-gradient-to-br from-purple-50 via-white to-blue-50">
      {/* Background elements */}
      <div className="absolute inset-0 overflow-hidden z-0">
        <div className="absolute top-1/4 -left-32 w-96 h-96 bg-purple-300/20 rounded-full blur-3xl"></div>
        <div className="absolute bottom-1/3 -right-32 w-96 h-96 bg-blue-300/20 rounded-full blur-3xl"></div>
        <div className="absolute w-full h-full bg-[radial-gradient(circle_at_center,rgba(255,255,255,0)_0%,rgba(255,255,255,0.8)_100%)]"></div>
      </div>

      <div className="container mx-auto px-4 z-10">
        <div className="flex flex-col md:flex-row items-center gap-12">
          <div className="md:w-1/2 space-y-6 animate-fade-in">
            <h1 className="text-5xl md:text-6xl font-bold leading-tight">
              {t('download.title')} <span className="bg-gradient-to-r from-blue-800 to-blue-600 bg-clip-text text-transparent">ArbiProSeller</span> {t('download.title_today')}
            </h1>
            <p className="text-lg md:text-xl text-gray-600">
              {t('download.subtitle')}
            </p>
            <div className="pt-4">
              <Button 
                size="lg" 
                className="group bg-gradient-to-r from-purple-600 to-blue-500 hover:from-purple-700 hover:to-blue-600"
                onClick={handleDownloadClick}
                disabled={isAttemptingDownload || isDownloading}
              >
                <Download className="mr-2 group-hover:animate-bounce" />
                {isAttemptingDownload || isDownloading ? t('download.downloading') : t('download.download_30_days_free')}
              </Button>
            </div>
            <div className="flex items-center gap-2 text-gray-500 text-sm animate-pulse">
              <ArrowDown size={14} />
              <span>Scroll down for simple installation steps</span>
            </div>
          </div>

          <div className="md:w-1/2 relative">
            <div className="relative z-10 animate-float">
              <div className="bg-white rounded-2xl shadow-2xl border border-gray-100 overflow-hidden p-6">
                <div className="space-y-4">
                  <div className="flex items-center">
                    <div className="w-12 h-12 rounded-full bg-purple-100 flex items-center justify-center mr-4">
                      <Download className="text-purple-600" />
                    </div>
                    <div>
                      <h3 className="font-bold text-xl">ArbiProSeller</h3>
                      <p className="text-gray-500">Windows Installer</p>
                    </div>
                  </div>
                  
                  <div className="h-px bg-gray-100 my-2"></div>
                  
                  <div className="bg-gray-50 rounded-lg p-4">
                    <p className="font-medium text-center">{t('download.one_click_installation')}</p>
                    <div className="flex justify-center mt-3">
                      <div className="h-2 w-2/3 bg-purple-200 rounded-full overflow-hidden">
                        <div className="h-full w-2/3 bg-purple-500 rounded-full"></div>
                      </div>
                    </div>
                  </div>
                  
                  <div className="bg-green-50 rounded-lg p-4 text-green-800">
                    <p className="text-center">{t('download.start_growing')}</p>
                  </div>
                </div>
              </div>
              
              <div className="absolute -z-10 w-full h-full rounded-2xl bg-gradient-to-r from-purple-500 to-blue-500 blur-sm -bottom-3 -right-3"></div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default DownloadHero;
