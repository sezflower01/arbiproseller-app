
import React from "react";
import { Star, AlertCircle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { useLanguage } from "@/contexts/LanguageContext";

const RecommendationsBlock = () => {
  const { t } = useLanguage();

  return (
    <Card className="bg-gradient-to-br from-purple-50 to-blue-50 border-purple-200 shadow-lg max-w-3xl mx-auto my-8">
      <CardContent className="p-6">
        <div className="space-y-6">
          <h2 className="text-2xl font-bold text-purple-800 flex items-center gap-2 mb-4">
            <Star className="text-purple-600" />
            {t('recommendations.title')}
          </h2>
          
          <ul className="space-y-4">
            {[
              t('recommendations.item1'),
              t('recommendations.item2'),
              t('recommendations.item3'),
              t('recommendations.item4'),
              t('recommendations.item5'),
              t('recommendations.item6'),
              t('recommendations.item7')
            ].map((item, index) => (
              <li key={index} className="flex items-start gap-3">
                <span className="text-purple-600 mt-1">
                  {index === 2 ? (
                    <AlertCircle size={18} className="text-blue-600" />
                  ) : (
                    <Star size={18} />
                  )}
                </span>
                <span className="text-gray-700">{item}</span>
              </li>
            ))}
          </ul>
          
          <div className="mt-4 bg-purple-100 rounded-lg p-4">
            <p className="text-purple-800 text-sm">
              <strong>{t('recommendations.pro_tip_label')}</strong> {t('recommendations.pro_tip_text')}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

export default RecommendationsBlock;
