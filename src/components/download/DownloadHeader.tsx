
import React from "react";
import { useLanguage } from "@/contexts/LanguageContext";

const DownloadHeader = () => {
  const { t } = useLanguage();
  
  return (
    <div className="text-center">
      <h1 className="text-4xl md:text-5xl font-bold mb-6">
        <span className="bg-gradient-to-r from-blue-800 to-blue-600 bg-clip-text text-transparent">ArbiProSeller</span> {t('download.title')}
      </h1>
      <p className="text-xl text-gray-600 max-w-3xl mx-auto mb-10">
        {t('download.subtitle')}
      </p>
    </div>
  );
};

export default DownloadHeader;
