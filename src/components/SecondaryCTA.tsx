
import React from 'react';
import { Button } from "@/components/ui/button";
import { Download, ArrowRight } from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';

const SecondaryCTA = () => {
  const { t } = useLanguage();

  const handleDownloadClick = () => {
    if (typeof gtag !== 'undefined') {
      gtag('event', 'cta_click', {
        event_category: 'engagement',
        event_label: 'secondary_cta_download',
        value: 1
      });
    }
    window.location.href = '/signup';
  };

  const handleLearnMoreClick = () => {
    if (typeof gtag !== 'undefined') {
      gtag('event', 'cta_click', {
        event_category: 'engagement',
        event_label: 'secondary_cta_learn_more',
        value: 1
      });
    }
    document.getElementById('overview')?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <section className="py-16 bg-gradient-to-r from-purple-600 to-blue-600">
      <div className="container mx-auto px-4 text-center">
        <div className="max-w-3xl mx-auto">
          <h2 className="text-3xl md:text-4xl font-bold text-white mb-6">
            {t('secondary_cta.title')}
          </h2>
          <p className="text-xl text-purple-100 mb-8 leading-relaxed">
            {t('secondary_cta.description')}
          </p>
          
          <div className="flex flex-col sm:flex-row gap-4 justify-center items-center">
            <Button 
              size="lg"
              className="bg-white text-purple-600 hover:bg-gray-100 font-semibold text-lg px-8 py-6 h-auto shadow-lg hover:shadow-xl transition-all duration-300"
              onClick={handleDownloadClick}
            >
              <Download className="mr-2" size={24} />
              {t('secondary_cta.download_free_trial')}
            </Button>
            
            <Button 
              variant="outline"
              size="lg"
              className="border-2 border-white text-white hover:bg-white hover:text-purple-600 font-semibold text-lg px-8 py-6 h-auto transition-all duration-300"
              onClick={handleLearnMoreClick}
            >
              {t('secondary_cta.learn_more')}
              <ArrowRight className="ml-2" size={20} />
            </Button>
          </div>
          
          <div className="mt-6 text-purple-100 text-sm">
            <span className="inline-block mr-6">✓ {t('secondary_cta.free_trial_30_days')}</span>
            <span className="inline-block mr-6">✓ {t('secondary_cta.no_credit_card')}</span>
            <span className="inline-block">✓ {t('secondary_cta.windows_compatible')}</span>
          </div>
        </div>
      </div>
    </section>
  );
};

export default SecondaryCTA;
