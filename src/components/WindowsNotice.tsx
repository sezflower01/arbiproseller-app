
import React from "react";
import { Monitor } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";

const WindowsNotice = () => {
  const { t } = useLanguage();
  
  return (
    <section className="my-10 max-w-2xl mx-auto">
      <div className="bg-blue-50 border-l-4 border-blue-500 rounded p-6 flex items-start gap-4 shadow-sm">
        <div className="mt-1">
          <Monitor size={32} className="text-blue-500" />
        </div>
        <div>
          <h3 className="font-bold text-lg mb-1 text-blue-900">{t('download.windows_notice_title')}</h3>
          <p className="text-blue-900 text-base">
            {t('download.windows_notice_description_1')}
          </p>
          <p className="text-blue-900 text-sm mt-2">
            {t('download.windows_notice_description_2')}
          </p>
        </div>
      </div>
    </section>
  );
};

export default WindowsNotice;
