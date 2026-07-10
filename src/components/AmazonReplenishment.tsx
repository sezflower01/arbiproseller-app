
import React, { useState } from 'react';
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { useLanguage } from '@/contexts/LanguageContext';

const AmazonReplenishment = () => {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const { t } = useLanguage();

  return (
    <section id="amazon-replenishment" className="py-20 bg-white">
      <div className="container mx-auto px-4">
        <div className="text-center max-w-3xl mx-auto mb-16">
          <h2 className="text-3xl md:text-4xl font-bold mb-4">
            <span className="bg-gradient-to-r from-brand-700 to-brand-900 bg-clip-text text-transparent">
              {t('amazon_replenishment.subtitle')}
            </span>
          </h2>
          <p className="text-gray-600 text-lg mb-8">
            {t('amazon_replenishment.description')}
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-start">
          <div className="prose prose-slate max-w-none">
            <div className="space-y-6">
              <h3 className="text-xl font-semibold text-brand-900">{t('amazon_replenishment.instructions_title')}</h3>
              
              <section>
                <h4 className="text-lg font-medium text-brand-800">{t('amazon_replenishment.step1_title')}</h4>
                <p className="text-gray-700">
                  {t('amazon_replenishment.step1_description')}
                </p>
              </section>

              <section>
                <h4 className="text-lg font-medium text-brand-800">{t('amazon_replenishment.step2_title')}</h4>
                <p className="text-gray-700">
                  {t('amazon_replenishment.step2_description')}
                </p>
              </section>

              <section>
                <h4 className="text-lg font-medium text-brand-800">{t('amazon_replenishment.step3_title')}</h4>
                <p className="text-gray-700">
                  {t('amazon_replenishment.step3_description')}
                </p>
              </section>

              <section>
                <h4 className="text-lg font-medium text-brand-800">{t('amazon_replenishment.step4_title')}</h4>
                <p className="text-gray-700">
                  {t('amazon_replenishment.step4_description')}
                </p>
              </section>

              <section>
                <h4 className="text-lg font-medium text-brand-800">{t('amazon_replenishment.step5_title')}</h4>
                <p className="text-gray-700">
                  {t('amazon_replenishment.step5_description')}
                </p>
              </section>

              <section className="mt-8">
                <h3 className="text-xl font-semibold text-brand-900">{t('amazon_replenishment.quick_tips_title')}</h3>
                <ul className="list-none space-y-2 mt-4">
                  <li className="flex items-start">
                    <span className="text-brand-600 mr-2">✅</span>
                    {t('amazon_replenishment.tip1')}
                  </li>
                  <li className="flex items-start">
                    <span className="text-brand-600 mr-2">✅</span>
                    {t('amazon_replenishment.tip2')}
                  </li>
                  <li className="flex items-start">
                    <span className="text-brand-600 mr-2">✅</span>
                    {t('amazon_replenishment.tip3')}
                  </li>
                </ul>
              </section>

              <section className="mt-8">
                <h3 className="text-xl font-semibold text-brand-900">{t('amazon_replenishment.why_use_title')}</h3>
                <ul className="list-disc ml-6 mt-2 text-gray-700">
                  <li>{t('amazon_replenishment.why_use_1')}</li>
                  <li>{t('amazon_replenishment.why_use_2')}</li>
                  <li>{t('amazon_replenishment.why_use_3')}</li>
                </ul>
              </section>
            </div>
          </div>

          <div className="relative space-y-4">
            <Card className="bg-white shadow-xl border border-brand-100/50 overflow-hidden sticky top-24">
              <CardContent className="p-4">
                <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
                  <DialogTrigger asChild>
                    <img 
                      src="/lovable-uploads/6b6aab2d-f4ee-4bb0-b378-491ebe4dc6ab.png" 
                      alt="ArbiProSeller Amazon Replenishment Process" 
                      className="w-full h-auto rounded cursor-zoom-in"
                    />
                  </DialogTrigger>
                  <DialogContent className="max-w-[90vw] w-full p-0 bg-transparent border-none">
                    <img 
                      src="/lovable-uploads/6b6aab2d-f4ee-4bb0-b378-491ebe4dc6ab.png" 
                      alt="ArbiProSeller Amazon Replenishment Process (Zoomed)" 
                      className="w-full h-auto max-h-[95vh] object-contain"
                    />
                  </DialogContent>
                </Dialog>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </section>
  );
};

export default AmazonReplenishment;
