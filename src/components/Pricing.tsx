
import { CircleDollarSign, Infinity, FileText, Cloud } from 'lucide-react';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useNavigate } from 'react-router-dom';
import { useLanguage } from '@/contexts/LanguageContext';

const Pricing = () => {
  const navigate = useNavigate();
  const { t } = useLanguage();
  
  const handleBuyNow = () => {
    navigate('/buy-license');
  };
  
  return (
    <section id="pricing" className="py-20 bg-gradient-to-b from-gray-50 to-white">
      <div className="container mx-auto px-4">
        <div className="text-center mb-12">
          <h2 className="text-3xl md:text-4xl font-bold mb-4 bg-gradient-to-r from-blue-800 to-blue-600 bg-clip-text text-transparent">
            {t('pricing.title')}
          </h2>
          <p className="text-lg text-gray-600 max-w-2xl mx-auto">
            {t('pricing.subtitle')}
          </p>
        </div>

        <div className="max-w-3xl mx-auto">
          <Card className="border-2 border-purple-200 shadow-lg transform transition-all hover:shadow-xl hover:-translate-y-1">
            <CardHeader className="text-center pb-2">
              <div className="flex items-center justify-center gap-2 mb-2">
                <span className="inline-flex items-center justify-center bg-purple-100 text-purple-700 rounded-full px-4 py-1 text-sm font-medium">
                  {t('pricing.most_popular')}
                </span>
              </div>
              <CardTitle className="text-3xl font-bold bg-gradient-to-r from-purple-700 to-blue-600 bg-clip-text text-transparent">
                {t('pricing.lifetime_license')}
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-6">
              <div className="text-center mb-8">
                <div className="flex items-center justify-center gap-2 text-2xl font-bold text-gray-900">
                  <CircleDollarSign className="h-6 w-6 text-purple-600" />
                  <span>{t('pricing.one_time_payment')}</span>
                </div>
              </div>
              
              <div className="space-y-4">
                <div className="flex items-start gap-3">
                  <Infinity className="h-5 w-5 text-purple-600 mt-1 flex-shrink-0" />
                  <span>{t('pricing.unlimited_devices')}</span>
                </div>
                <div className="flex items-start gap-3">
                  <FileText className="h-5 w-5 text-purple-600 mt-1 flex-shrink-0" />
                  <span>{t('pricing.lifetime_access')}</span>
                </div>
                <div className="flex items-start gap-3">
                  <CircleDollarSign className="h-5 w-5 text-purple-600 mt-1 flex-shrink-0" />
                  <span>{t('pricing.no_monthly_fees')}</span>
                </div>
                <div className="flex items-start gap-3">
                  <Cloud className="h-5 w-5 text-purple-600 mt-1 flex-shrink-0" />
                  <span>{t('pricing.cloud_backup')}</span>
                </div>
                <div className="flex items-start gap-3">
                  <FileText className="h-5 w-5 text-purple-600 mt-1 flex-shrink-0" />
                  <span>{t('pricing.amazon_sellers')}</span>
                </div>
                <div className="flex items-start gap-3">
                  <Infinity className="h-5 w-5 text-purple-600 mt-1 flex-shrink-0" />
                  <span>{t('pricing.free_updates')}</span>
                </div>
              </div>
            </CardContent>
            <CardFooter className="pt-4">
              <Button 
                onClick={handleBuyNow} 
                className="w-full py-6 text-lg bg-gradient-to-r from-purple-600 to-blue-500 hover:from-purple-700 hover:to-blue-600 transition-all duration-200 shadow-lg hover:shadow-xl" 
                size="lg"
              >
                {t('pricing.buy_now_button')}
              </Button>
            </CardFooter>
          </Card>
        </div>
      </div>
    </section>
  );
};

export default Pricing;
