
import React, { useState } from 'react';
import { Card, CardContent } from "@/components/ui/card";
import { Package2 } from "lucide-react";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { useLanguage } from '@/contexts/LanguageContext';

const RepurchaseDecision = () => {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const { t } = useLanguage();

  return (
    <section id="repurchase-decision" className="py-20 bg-gray-50">
      <div className="container mx-auto px-4">
        <div className="text-center max-w-3xl mx-auto mb-16">
          <h2 className="text-3xl md:text-4xl font-bold mb-4">
            <span className="bg-gradient-to-r from-brand-700 to-brand-900 bg-clip-text text-transparent">
              {t('repurchase_decision.subtitle')}
            </span>
          </h2>
          <p className="text-gray-600 text-lg">
            {t('repurchase_decision.description')}
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-start">
          <div className="prose prose-slate max-w-none">
            <div className="space-y-6">
              <section>
                <h3 className="text-xl font-semibold text-brand-900 flex items-center gap-2">
                  <Package2 className="h-6 w-6 text-brand-600" />
                  {t('repurchase_decision.how_it_works_title')}
                </h3>
                <ul className="list-disc ml-6 mt-2 text-gray-700">
                  <li>{t('repurchase_decision.how_it_works_1')}</li>
                  <li>{t('repurchase_decision.how_it_works_2')}</li>
                  <li>{t('repurchase_decision.how_it_works_3')}</li>
                </ul>
              </section>

              <section className="bg-blue-50 p-6 rounded-lg border border-blue-100">
                <h3 className="text-xl font-semibold text-brand-900 mb-4">{t('repurchase_decision.extra_tips_title')}</h3>
                <ul className="list-disc ml-6 text-gray-700 space-y-3">
                  <li>{t('repurchase_decision.extra_tips_1')}</li>
                  <li>{t('repurchase_decision.extra_tips_2')}</li>
                  <li>{t('repurchase_decision.extra_tips_3')}</li>
                  <li>{t('repurchase_decision.extra_tips_4')}</li>
                  <li>{t('repurchase_decision.extra_tips_5')}</li>
                  <li>{t('repurchase_decision.extra_tips_6')}</li>
                </ul>
              </section>
            </div>
          </div>

          <div className="relative">
            <Card className="bg-white shadow-xl border border-brand-100/50 overflow-hidden sticky top-24">
              <CardContent className="p-4">
                <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
                  <DialogTrigger asChild>
                    <img 
                      src="/lovable-uploads/710f6a23-783a-4e0e-93e5-eda9dd0c3421.png" 
                      alt="ArbiProSeller main application interface showing dashboard and product management features" 
                      className="w-full h-auto rounded cursor-zoom-in"
                    />
                  </DialogTrigger>
                  <DialogContent className="max-w-[90vw] w-full p-0 bg-transparent border-none">
                    <img 
                      src="/lovable-uploads/710f6a23-783a-4e0e-93e5-eda9dd0c3421.png" 
                      alt="ArbiProSeller main application interface (Zoomed)" 
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

export default RepurchaseDecision;
