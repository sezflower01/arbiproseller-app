
import React from "react";
import { useLanguage } from "@/contexts/LanguageContext";

const PaymentInstructions = () => {
  const { t } = useLanguage();
  
  return (
    <div className="bg-gray-50 rounded-lg p-6 border border-gray-200">
      <h3 className="text-lg font-semibold mb-3">{t('payment.instructions.title')}</h3>
      <ol className="list-decimal ml-5 space-y-2">
        <li>{t('payment.instructions.step1')}</li>
        <li>{t('payment.instructions.step2')}</li>
        <li>{t('payment.instructions.step3')}</li>
        <li>{t('payment.instructions.step4')}</li>
      </ol>
      <div className="mt-4 text-sm text-gray-500">
        <p>{t('payment.instructions.help_text')} <a href="mailto:support@arbiproseller.com" className="text-purple-600 hover:text-purple-800">support@arbiproseller.com</a></p>
      </div>
    </div>
  );
};

export default PaymentInstructions;
