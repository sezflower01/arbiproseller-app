
import React from "react";
import { CheckCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useNavigate } from "react-router-dom";

const PaymentSuccess = () => {
  const navigate = useNavigate();
  
  return (
    <div className="max-w-3xl mx-auto text-center">
      <div className="flex justify-center mb-6">
        <CheckCircle className="h-16 w-16 text-green-500" />
      </div>
      <h1 className="text-3xl md:text-4xl font-bold mb-6">
        Thank You For Your Purchase!
      </h1>
      <div className="bg-green-50 border border-green-200 rounded-lg p-6 mb-8">
        <p className="text-lg mb-4">
          Your Inventory S.P.R.I.N.T. license key will be sent to your email within 24 hours.
        </p>
        <p className="text-gray-600">
          If you don't receive your license key, please check your spam folder or contact our support team.
        </p>
      </div>
      <Button onClick={() => navigate('/admin')} size="lg">
        Download Software
      </Button>
    </div>
  );
};

export default PaymentSuccess;
