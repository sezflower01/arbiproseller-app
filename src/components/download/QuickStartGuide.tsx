
import React from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Check, Download, Info } from "lucide-react";
import RecommendationsBlock from "@/components/RecommendationsBlock";
import { useLanguage } from "@/contexts/LanguageContext";

const QuickStartGuide = () => {
  const { t } = useLanguage();

  return (
    <div className="max-w-3xl mx-auto mt-8 space-y-8">
      <Card className="bg-white shadow-lg">
        <CardContent className="p-6">
          <div className="space-y-6">
            <div className="border-b pb-4">
              <h2 className="text-2xl font-bold text-blue-600 flex items-center gap-2">
                <span className="inline-block w-4 h-4 bg-blue-500 rounded-full" />
                {t('download.quick_start_guide_title')}
              </h2>
              <p className="text-gray-600 mt-2">
                {t('download.quick_start_guide_subtitle')}
              </p>
            </div>

            <div className="space-y-6">
              <div className="space-y-4">
                <h3 className="text-lg font-semibold flex items-center gap-2 text-blue-600">
                  <Check className="text-blue-500" />
                  {t('download.step1_title')}
                </h3>
                <ul className="ml-6 space-y-2 text-gray-700">
                  <li>• <button 
                      onClick={() => window.open('https://mstibdszibcheodvnprm.supabase.co/storage/v1/object/sign/access/Setup_ArbiProSellerNoAPI.exe?token=eyJraWQiOiJzdG9yYWdlLXVybC1zaWduaW5nLWtleV9iODE0YWYxZi1jYzk3LTQ2MTAtOTc1ZC03ZjY4YWMxNGY1MjQiLCJhbGciOiJIUzI1NiJ9.eyJ1cmwiOiJhY2Nlc3MvU2V0dXBfQXJiaVByb1NlbGxlck5vQVBJLmV4ZSIsImlhdCI6MTc3MTk4ODA4NywiZXhwIjoyMDI0Mjc2MDg3fQ.SwVNAcNtdC3T_Ql0t346UlKJ7yc0EDEsGLufYciaZU4', '_blank')}
                      className="text-blue-600 hover:text-blue-800 underline cursor-pointer"
                    >
                      {t('download.step1_item1')}
                    </button></li>
                  <li>• {t('download.step1_item2')}</li>
                  <li>• {t('download.step1_item3')}</li>
                </ul>
              </div>

              <div className="space-y-4">
                <h3 className="text-lg font-semibold flex items-center gap-2 text-purple-600">
                  <Check className="text-purple-500" />
                  {t('download.step2_title')}
                </h3>
                <ul className="ml-6 space-y-2 text-gray-700">
                  <li>• {t('download.step2_item1')}</li>
                  <li>• {t('download.step2_item2')}</li>
                  <li>• {t('download.step2_item3')}</li>
                </ul>
                <div className="bg-purple-50 p-4 rounded-lg">
                  <p className="text-purple-800 font-medium">
                    {t('download.step2_note')}
                  </p>
                </div>
              </div>

              <div className="space-y-4">
                <h3 className="text-lg font-semibold flex items-center gap-2 text-cyan-600">
                  <Check className="text-cyan-500" />
                  {t('download.step3_title')}
                </h3>
                <ul className="ml-6 space-y-2 text-gray-700">
                  <li>• {t('download.step3_item1')}</li>
                  <li>• {t('download.step3_item2')}</li>
                  <ul className="ml-6 space-y-1 text-gray-600">
                    <li>- {t('download.step3_subitem1')}</li>
                    <li>- {t('download.step3_subitem2')}</li>
                    <li>- {t('download.step3_subitem3')}</li>
                  </ul>
                  <li>• {t('download.step3_item3')}</li>
                </ul>
              </div>

              <div className="space-y-4">
                <h3 className="text-lg font-semibold flex items-center gap-2 text-indigo-600">
                  <Check className="text-indigo-500" />
                  {t('download.step4_title')}
                </h3>
                <ul className="ml-6 space-y-2 text-gray-700">
                  <li>• {t('download.step4_item1')}</li>
                  <li>• {t('download.step4_item2')}</li>
                  <li>• {t('download.step4_item3')}</li>
                  <li>• {t('download.step4_item4')}</li>
                  <li>• {t('download.step4_item5')}</li>
                </ul>
              </div>
            </div>

            <div className="mt-6 space-y-4">
              <div className="bg-blue-50 p-4 rounded-lg">
                <h3 className="font-semibold text-blue-800 flex items-center gap-2">
                  <Info className="text-blue-600" />
                  {t('download.trial_section_title')}
                </h3>
                <ul className="ml-4 mt-2 space-y-1 text-blue-700">
                  <li>• {t('download.trial_item1')}</li>
                  <li>• {t('download.trial_item2')}</li>
                  <li>• {t('download.trial_item3')}</li>
                </ul>
              </div>

              <div className="bg-purple-50 p-4 rounded-lg">
                <h3 className="font-semibold text-purple-800">{t('download.need_help_title')}</h3>
                <p className="text-purple-700 mt-1">
                  {t('download.need_help_contact')}
                </p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
      
      <RecommendationsBlock />
    </div>
  );
};

export default QuickStartGuide;
