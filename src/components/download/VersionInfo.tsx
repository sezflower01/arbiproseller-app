
import React from "react";
import { useLanguage } from "@/contexts/LanguageContext";

const VersionInfo = () => {
  const { t } = useLanguage();
  
  return (
    <div className="mt-6 text-sm text-gray-500">
      {t('download.version_info')}
    </div>
  );
};

export default VersionInfo;
