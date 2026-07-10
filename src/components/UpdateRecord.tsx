
import React from 'react';
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { AspectRatio } from "@/components/ui/aspect-ratio";
import { FileText } from "lucide-react";
import { useLanguage } from '@/contexts/LanguageContext';

const UpdateRecord = () => {
  const { t } = useLanguage();

  return (
    <section className="py-20 bg-white">
      <div className="container mx-auto px-4">
        <div className="text-center max-w-3xl mx-auto mb-16">
          <h2 className="text-3xl md:text-4xl font-bold mb-4">
            <span className="bg-gradient-to-r from-brand-700 to-brand-900 bg-clip-text text-transparent flex items-center justify-center gap-2">
              <FileText className="h-8 w-8" />
              {t('update_record.title')}
            </span>
          </h2>
          <p className="text-gray-600 text-lg">
            {t('update_record.description')}
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-start">
          <div className="space-y-6">
            <div className="space-y-4">
              <p className="text-gray-700">
                {t('update_record.explanation')}
              </p>

              <div className="mt-8">
                <h3 className="text-xl font-semibold mb-4 text-brand-900">{t('update_record.why_matters_title')}</h3>
                <ul className="space-y-4">
                  <li className="flex items-start gap-3">
                    <span className="text-2xl">📈</span>
                    <span className="text-gray-700">
                      {t('update_record.benefit1')}
                    </span>
                  </li>
                  <li className="flex items-start gap-3">
                    <span className="text-2xl">🛒</span>
                    <span className="text-gray-700">
                      {t('update_record.benefit2')}
                    </span>
                  </li>
                  <li className="flex items-start gap-3">
                    <span className="text-2xl">🧹</span>
                    <span className="text-gray-700">
                      {t('update_record.benefit3')}
                    </span>
                  </li>
                  <li className="flex items-start gap-3">
                    <span className="text-2xl">🔎</span>
                    <span className="text-gray-700">
                      {t('update_record.benefit4')}
                    </span>
                  </li>
                </ul>
              </div>
            </div>
          </div>

          <Dialog>
            <DialogTrigger asChild>
              <Card className="cursor-pointer hover:shadow-lg transition-shadow">
                <CardContent className="p-2">
                  <AspectRatio ratio={16/9}>
                    <img 
                      src="/lovable-uploads/141a2bae-1550-4250-a70d-eb45c63c8786.png"
                      alt="Update Record Feature in ArbiProSeller"
                      className="w-full h-full object-contain rounded"
                    />
                  </AspectRatio>
                </CardContent>
              </Card>
            </DialogTrigger>
            <DialogContent className="max-w-4xl">
              <AspectRatio ratio={16/9}>
                <img 
                  src="/lovable-uploads/141a2bae-1550-4250-a70d-eb45c63c8786.png"
                  alt="Update Record Feature in ArbiProSeller"
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

export default UpdateRecord;
