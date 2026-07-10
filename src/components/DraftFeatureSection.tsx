
import React from 'react';
import { useLanguage } from '@/contexts/LanguageContext';

const DraftFeatureSection = () => {
  const { t } = useLanguage();

  return (
    <section id="draft-feature" className="py-20 bg-gray-50">
      <div className="container mx-auto px-4">
        <div className="text-center max-w-4xl mx-auto mb-16">
          <h2 className="text-3xl md:text-4xl font-bold mb-4 text-brand-900">
            {t('draft_feature.title')}
          </h2>
          <h3 className="text-xl md:text-2xl font-semibold mb-6 text-brand-700">
            {t('draft_feature.subtitle')}
          </h3>
          <p className="text-lg text-gray-700 mb-8">
            {t('draft_feature.description')}
          </p>
        </div>

        <div className="max-w-4xl mx-auto space-y-12">
          <div className="bg-white rounded-2xl p-8 shadow-lg">
            <h4 className="text-2xl font-bold mb-6 text-brand-900">
              {t('draft_feature.how_it_works_title')}
            </h4>
            <div className="space-y-4 text-gray-700">
              <p>1. {t('draft_feature.how_it_works_1')}</p>
              <p>2. {t('draft_feature.how_it_works_2')}</p>
              <p>3. {t('draft_feature.how_it_works_3')}</p>
            </div>
          </div>

          <div className="bg-blue-50 rounded-2xl p-8">
            <h4 className="text-2xl font-bold mb-6 text-blue-900">
              {t('draft_feature.purpose_title')}
            </h4>
            <div className="space-y-4 text-gray-700">
              <p>• {t('draft_feature.purpose_1')}</p>
              <p>• {t('draft_feature.purpose_2')}</p>
              <p>• {t('draft_feature.purpose_3')}</p>
            </div>
          </div>

          <div className="bg-gradient-to-r from-purple-600 to-blue-600 text-white rounded-2xl p-8">
            <h4 className="text-2xl font-bold mb-6">
              {t('draft_feature.pro_tip_title')}
            </h4>
            <div className="space-y-3">
              <p>• {t('draft_feature.pro_tip_1')}</p>
              <p>• {t('draft_feature.pro_tip_2')}</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default DraftFeatureSection;
