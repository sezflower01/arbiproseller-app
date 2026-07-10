
import React, { useState } from 'react';
import { Card, CardContent } from "@/components/ui/card";
import { FileText, Maximize2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useLanguage } from '@/contexts/LanguageContext';

const DraftHistory = () => {
  const [isImageZoomed, setIsImageZoomed] = useState(false);
  const { t } = useLanguage();

  return (
    <section id="draft-history" className="py-20 bg-gray-50">
      <div className="container mx-auto px-4">
        <div className="text-center max-w-3xl mx-auto mb-16">
          <h2 className="text-3xl md:text-4xl font-bold mb-4">
            <span className="bg-gradient-to-r from-brand-700 to-brand-900 bg-clip-text text-transparent">{t("draft_history.title")}</span>
          </h2>
          <p className="text-gray-600 text-lg">
            {t("draft_history.subtitle")}
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-start">
          <div className="prose prose-slate max-w-none">
            <div className="space-y-6">
              <section>
                <h3 className="text-xl font-semibold text-brand-900 flex items-center gap-2">
                  <FileText className="h-6 w-6 text-brand-600" />
                  {t("draft_history.key_features_title")}
                </h3>
                <ul className="list-disc ml-6 mt-2 text-gray-700">
                  <li>{t("draft_history.feature1")}</li>
                  <li>{t("draft_history.feature2")}</li>
                </ul>
              </section>

              <section>
                <h3 className="text-xl font-semibold text-brand-900 mt-8">{t("draft_history.why_matters_title")}</h3>
                <ul className="space-y-4 mt-4">
                  <li className="flex items-start gap-3">
                    <span className="text-2xl">📈</span>
                    <span>{t("draft_history.benefit1")}</span>
                  </li>
                  <li className="flex items-start gap-3">
                    <span className="text-2xl">🛒</span>
                    <span>{t("draft_history.benefit2")}</span>
                  </li>
                  <li className="flex items-start gap-3">
                    <span className="text-2xl">🧹</span>
                    <span>{t("draft_history.benefit3")}</span>
                  </li>
                </ul>
              </section>
            </div>
          </div>

          <div className="relative">
            <Card className="bg-white shadow-xl border border-brand-100/50 overflow-hidden sticky top-24">
              <CardContent className="p-4 relative">
                <Dialog open={isImageZoomed} onOpenChange={setIsImageZoomed}>
                  <DialogTrigger asChild>
                    <div className="relative group cursor-pointer">
                      <img 
                        src="/lovable-uploads/ed190ec2-4208-4f10-b3f9-691ee94884c3.png" 
                        alt="ArbiProSeller Draft Management Interface" 
                        className="w-full h-auto rounded group-hover:opacity-80 transition-opacity"
                      />
                      <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
                        <Maximize2 className="text-brand-600 bg-white/70 rounded-full p-1 w-8 h-8" />
                      </div>
                    </div>
                  </DialogTrigger>
                  <DialogContent className="max-w-4xl w-full">
                    <DialogHeader className="sr-only">
                      <h2>Enlarged Draft Management Interface</h2>
                    </DialogHeader>
                    <img 
                      src="/lovable-uploads/ed190ec2-4208-4f10-b3f9-691ee94884c3.png" 
                      alt="Enlarged ArbiProSeller Draft Management Interface" 
                      className="w-full h-auto rounded"
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

export default DraftHistory;
