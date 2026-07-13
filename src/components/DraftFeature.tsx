
import React from 'react';
import { Card, CardContent } from "@/components/ui/card";
import { FileText } from "lucide-react";
import { useLanguage } from '@/contexts/LanguageContext';

const DraftFeature = () => {
  const { t } = useLanguage();

  return (
    <section id="draft-feature" className="py-20 bg-gray-50">
      <div className="container mx-auto px-4">
        <div className="text-center max-w-3xl mx-auto mb-16">
          <h2 className="text-3xl md:text-4xl font-bold mb-4">
            <span className="bg-gradient-to-r from-brand-700 to-brand-900 bg-clip-text text-transparent">
              {t('draft_feature.subtitle')}
            </span>
          </h2>
          <p className="text-gray-600 text-lg">
            {t('draft_feature.description')}
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-start">
          <div className="prose prose-slate max-w-none">
            <div className="space-y-6">
              <section>
                <h3 className="text-xl font-semibold text-brand-900 flex items-center gap-2">
                  <FileText className="h-6 w-6 text-brand-600" />
                  {t('draft_feature.how_it_works_title')}
                </h3>
                <ul className="list-disc ml-6 mt-2 text-gray-700">
                  <li>{t('draft_feature.how_it_works_1')}</li>
                  <li>{t('draft_feature.how_it_works_2')}</li>
                  <li>{t('draft_feature.how_it_works_3')}</li>
                </ul>
              </section>

              <section>
                <h3 className="text-xl font-semibold text-brand-900 flex items-center gap-2">
                  <FileText className="h-6 w-6 text-brand-600" />
                  {t('draft_feature.purpose_title')}
                </h3>
                <ul className="list-disc ml-6 mt-2 text-gray-700">
                  <li>{t('draft_feature.purpose_1')}</li>
                  <li>{t('draft_feature.purpose_2')}</li>
                  <li>{t('draft_feature.purpose_3')}</li>
                </ul>
              </section>

              <section className="bg-blue-50 p-6 rounded-lg border border-blue-100">
                <h3 className="text-xl font-semibold text-brand-900 mb-4">{t('draft_feature.pro_tip_title')}</h3>
                <ul className="list-disc ml-6 text-gray-700">
                  <li>{t('draft_feature.pro_tip_1')}</li>
                  <li>{t('draft_feature.pro_tip_2')}</li>
                </ul>
              </section>
            </div>
          </div>

          <div className="relative">
            <Card className="bg-white shadow-xl border border-brand-100/50 overflow-hidden sticky top-24">
              <CardContent className="p-4">
                <img 
                  src="/lovable-uploads/9a09276d-7903-4434-a295-973afdb7ff96.png" 
                  alt="Inventory S.P.R.I.N.T. Draft Feature Interface"
                  className="w-full h-auto rounded"
                />
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </section>
  );
};

export default DraftFeature;
