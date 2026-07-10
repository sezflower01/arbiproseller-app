
import React from "react";
import { useLanguage } from "@/contexts/LanguageContext";

interface PaymentAlertProps {
  status: 'idle' | 'success' | 'canceled';
}

const PaymentAlert = ({ status }: PaymentAlertProps) => {
  const { t } = useLanguage();
  
  if (status === 'idle') return null;
  
  if (status === 'success') {
    return (
      <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-6">
        <p className="text-green-800">
          {t('payment.alert.success')}
        </p>
      </div>
    );
  }
  
  return (
    <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-6">
      <p className="text-amber-800">
        {t('payment.alert.canceled')}
      </p>
    </div>
  );
};

export default PaymentAlert;
