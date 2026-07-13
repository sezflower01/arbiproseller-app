
import React from 'react';
import { Card, CardContent } from "@/components/ui/card";
import { useLanguage } from '@/contexts/LanguageContext';

const InsertFormSection = () => {
  const { t } = useLanguage();

  return (
    <section id="insert-form" className="py-20 bg-white">
      <div className="container mx-auto px-4">
        <div className="text-center max-w-4xl mx-auto mb-16">
          <h2 className="text-3xl md:text-4xl font-bold mb-4 text-brand-900">
            {t('insert_form.title')}
          </h2>
          <h3 className="text-xl md:text-2xl font-semibold mb-6 text-brand-700">
            {t('insert_form.subtitle')}
          </h3>
          <p className="text-lg text-gray-700 mb-8">
            {t('insert_form.description')}
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-start">
          <div className="prose prose-slate max-w-none">
            <div className="space-y-6">
              <section>
                <h4 className="text-xl font-semibold text-brand-900 flex items-center gap-2">
                  {t('insert_form.step1_title')}
                </h4>
                <ul className="list-disc ml-6 mt-2 text-gray-700">
                  <li><strong>ASIN</strong> → {t('insert_form.step1_asin')}</li>
                  <li><strong>Store Link</strong> → {t('insert_form.step1_store_link')}</li>
                  <li><strong>Discount</strong> → {t('insert_form.step1_discount')}</li>
                </ul>
              </section>

              <section>
                <h4 className="text-xl font-semibold text-brand-900 flex items-center gap-2">
                  {t('insert_form.step2_title')}
                </h4>
                <ul className="list-disc ml-6 mt-2 text-gray-700">
                  <li><strong>Order Amount</strong> → {t('insert_form.step2_order_amount')}</li>
                  <li className="ml-6 text-blue-600">{t('insert_form.step2_order_example')}</li>
                  <li><strong>Units</strong> → {t('insert_form.step2_units')}</li>
                  <li className="ml-6 text-blue-600">{t('insert_form.step2_units_example')}</li>
                </ul>
              </section>

              <section>
                <h4 className="text-xl font-semibold text-brand-900 flex items-center gap-2">
                  {t('insert_form.step3_title')}
                </h4>
                <p className="mt-2 text-gray-700">
                  {t('insert_form.step3_description')}
                </p>
              </section>

              <section>
                <h4 className="text-xl font-semibold text-brand-900 flex items-center gap-2">
                  {t('insert_form.step4_title')}
                </h4>
                <ul className="list-disc ml-6 mt-2 text-gray-700">
                  <li>🚀 {t('insert_form.step4_title_fetch')}</li>
                  <li>🖼️ {t('insert_form.step4_image_fetch')}</li>
                  <li>✅ {t('insert_form.step4_no_manual')}</li>
                  <li>👁️ {t('insert_form.step4_image_confirm')}</li>
                </ul>
              </section>

              <section>
                <h4 className="text-xl font-semibold text-brand-900">{t('insert_form.benefits_title')}</h4>
                <ul className="list-disc ml-6 mt-2 text-gray-700">
                  <li>⚡ <strong>Fast:</strong> {t('insert_form.benefits_fast')}</li>
                  <li>🎯 <strong>Accurate:</strong> {t('insert_form.benefits_accurate')}</li>
                  <li>📋 <strong>Organized:</strong> {t('insert_form.benefits_organized')}</li>
                  <li>🔒 <strong>Safe:</strong> {t('insert_form.benefits_safe')}</li>
                </ul>
              </section>
            </div>
          </div>

          <div className="relative">
            <Card className="bg-white shadow-xl border border-brand-100/50 overflow-hidden sticky top-24">
              <CardContent className="p-4">
                <img 
                  src="/lovable-uploads/326793f9-1859-421d-8053-a791844a844c.png" 
                  alt="Inventory S.P.R.I.N.T. Insert Form Interface"
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

export default InsertFormSection;
