
import React from 'react';
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogTrigger,
} from "@/components/ui/dialog";
import { AspectRatio } from "@/components/ui/aspect-ratio";
import { useLanguage } from '@/contexts/LanguageContext';

const AutomaticSupplierDetection = () => {
  const { t } = useLanguage();

  return (
    <section className="py-20 bg-white">
      <div className="container mx-auto px-4">
        <div className="text-center max-w-3xl mx-auto mb-16">
          <h2 className="text-3xl md:text-4xl font-bold mb-4">
            <span className="bg-gradient-to-r from-brand-700 to-brand-900 bg-clip-text text-transparent">
              {t('automatic_supplier_detection.title')}
            </span>
          </h2>
          <p className="text-gray-600 text-lg mb-8">
            {t('automatic_supplier_detection.description')}
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-center">
          <div className="space-y-6">
            <div className="space-y-4">
              <div className="flex items-start gap-3">
                <span className="text-brand-600 text-xl">✅</span>
                <p className="text-gray-700">{t('automatic_supplier_detection.step1')}</p>
              </div>
              <div className="flex items-start gap-3">
                <span className="text-brand-600 text-xl">✅</span>
                <p className="text-gray-700">{t('automatic_supplier_detection.step2')}</p>
              </div>
              <div className="flex items-start gap-3">
                <span className="text-brand-600 text-xl">✅</span>
                <p className="text-gray-700">{t('automatic_supplier_detection.step3')}</p>
              </div>
            </div>

            <div className="mt-8">
              <h3 className="text-xl font-semibold mb-4 text-brand-900">{t('automatic_supplier_detection.why_matters_title')}</h3>
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <span className="text-brand-600">📈</span>
                  <p>{t('automatic_supplier_detection.benefit1')}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-brand-600">🛒</span>
                  <p>{t('automatic_supplier_detection.benefit2')}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-brand-600">🧹</span>
                  <p>{t('automatic_supplier_detection.benefit3')}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-brand-600">🔎</span>
                  <p>{t('automatic_supplier_detection.benefit4')}</p>
                </div>
              </div>
            </div>
          </div>

          <Dialog>
            <DialogTrigger asChild>
              <Card className="cursor-pointer hover:shadow-lg transition-shadow">
                <CardContent className="p-2">
                  <AspectRatio ratio={16/9} className="w-full">
                    <img 
                      src="/lovable-uploads/81b750ac-8f16-4a83-a3e2-8575a2a2c3d9.png"
                      alt="Automatic Supplier Name Detection in Inventory S.P.R.I.N.T."
                      className="w-full h-full object-contain rounded"
                    />
                  </AspectRatio>
                </CardContent>
              </Card>
            </DialogTrigger>
            <DialogContent className="max-w-4xl">
              <AspectRatio ratio={16/9} className="w-full">
                <img 
                  src="/lovable-uploads/81b750ac-8f16-4a83-a3e2-8575a2a2c3d9.png"
                  alt="Automatic Supplier Name Detection in Inventory S.P.R.I.N.T."
                  className="w-full h-full object-contain rounded"
                />
              </AspectRatio>
            </DialogContent>
          </Dialog>
        </div>
      </div>
    </section>
  );
};

export default AutomaticSupplierDetection;
