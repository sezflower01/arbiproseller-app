
import React from "react";
import { useLanguage } from "@/contexts/LanguageContext";

const NoMonthlyFees = () => {
  const { t } = useLanguage();

  return (
    <section id="no-monthly-fees" className="py-20 bg-gradient-to-br from-blue-50 to-indigo-100">
      <div className="container mx-auto px-4">
        <div className="max-w-4xl mx-auto text-center">
          <h2 className="text-3xl md:text-4xl font-bold text-gray-900 mb-6">
            {t('no_monthly_fees.title')}
          </h2>
          
          <p className="text-xl text-gray-700 mb-6 leading-relaxed">
            {t('no_monthly_fees.description')}
          </p>
          
          <p className="text-lg text-gray-600 mb-8 leading-relaxed">
            {t('no_monthly_fees.explanation')}
          </p>
          
          <div className="bg-white rounded-2xl shadow-lg p-8 mb-8">
            <h3 className="text-2xl font-semibold text-gray-900 mb-6">
              {t('no_monthly_fees.benefits_title')}
            </h3>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
              <div className="text-left">
                <p className="text-lg text-green-700 font-medium">
                  {t('no_monthly_fees.benefit1')}
                </p>
              </div>
              <div className="text-left">
                <p className="text-lg text-green-700 font-medium">
                  {t('no_monthly_fees.benefit2')}
                </p>
              </div>
              <div className="text-left">
                <p className="text-lg text-green-700 font-medium">
                  {t('no_monthly_fees.benefit3')}
                </p>
              </div>
              <div className="text-left">
                <p className="text-lg text-green-700 font-medium">
                  {t('no_monthly_fees.benefit4')}
                </p>
              </div>
            </div>
          </div>
          
          <p className="text-lg text-gray-700 leading-relaxed font-medium">
            {t('no_monthly_fees.conclusion')}
          </p>
        </div>
      </div>
    </section>
  );
};

export default NoMonthlyFees;
