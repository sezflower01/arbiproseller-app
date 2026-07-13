
import React, { useState } from 'react';
import { Card, CardContent } from "@/components/ui/card";
import { Flag } from "lucide-react";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { useLanguage } from '@/contexts/LanguageContext';

const FlagOrder = () => {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const { t } = useLanguage();

  return (
    <section id="flag-order" className="py-20 bg-white">
      <div className="container mx-auto px-4">
        <div className="text-center max-w-3xl mx-auto mb-16">
          <h2 className="text-3xl md:text-4xl font-bold mb-4">
            <span className="bg-gradient-to-r from-brand-700 to-brand-900 bg-clip-text text-transparent">
              {t('flag_order.subtitle')}
            </span>
          </h2>
          <p className="text-gray-600 text-lg">
            {t('flag_order.description')}
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-start">
          <div className="prose prose-slate max-w-none">
            <div className="space-y-6">
              <section>
                <h3 className="text-xl font-semibold text-brand-900 flex items-center gap-2">
                  <Flag className="h-6 w-6 text-brand-600" />
                  {t('flag_order.how_it_works_title')}
                </h3>
                <ul className="list-none space-y-4">
                  <li className="flex items-start gap-2">
                    <span className="text-brand-600 font-bold">✅</span>
                    <span>{t('flag_order.step1')}</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-brand-600 font-bold">✅</span>
                    <span>{t('flag_order.step2')}</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-brand-600 font-bold">✅</span>
                    <span>{t('flag_order.step3')}</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-brand-600 font-bold">✅</span>
                    <span>{t('flag_order.step4')}</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-brand-600 font-bold">✅</span>
                    <span>{t('flag_order.step5')}</span>
                  </li>
                </ul>
              </section>

              <section className="bg-blue-50 p-6 rounded-lg border border-blue-100">
                <h3 className="text-xl font-semibold text-brand-900 mb-4">{t('flag_order.why_important_title')}</h3>
                <ul className="list-none space-y-3">
                  <li className="flex items-start gap-2">
                    <span className="text-brand-600 font-bold">🧠</span>
                    <span>{t('flag_order.benefit1')}</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-brand-600 font-bold">📝</span>
                    <span>{t('flag_order.benefit2')}</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-brand-600 font-bold">🎯</span>
                    <span>{t('flag_order.benefit3')}</span>
                  </li>
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
                      src="/lovable-uploads/dbe47511-e68c-4c73-b11f-029f79b9ff31.png" 
                      alt="Inventory S.P.R.I.N.T. Flag Order Feature Interface"
                      className="w-full h-auto rounded cursor-zoom-in"
                    />
                  </DialogTrigger>
                  <DialogContent className="max-w-[90vw] w-full p-0 bg-transparent border-none">
                    <img 
                      src="/lovable-uploads/dbe47511-e68c-4c73-b11f-029f79b9ff31.png" 
                      alt="Inventory S.P.R.I.N.T. Flag Order Feature Interface (Zoomed)"
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

export default FlagOrder;
