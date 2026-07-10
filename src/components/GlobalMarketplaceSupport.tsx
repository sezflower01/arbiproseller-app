
import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Globe } from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';

const GlobalMarketplaceSupport = () => {
  const { t } = useLanguage();

  const marketplaces = [
    { icon: "🇺🇸", label: t('global_marketplace.united_states') },
    { icon: "🇨🇦", label: t('global_marketplace.canada') },
    { icon: "🇲🇽", label: t('global_marketplace.mexico') },
    { icon: "🇧🇷", label: t('global_marketplace.brazil') }
  ];

  return (
    <section id="global-marketplace-support" className="py-20 bg-gray-50">
      <div className="container mx-auto px-4 text-center">
        <div className="flex items-center justify-center mb-6">
          <Globe className="text-brand-600 w-10 h-10 mr-3" strokeWidth={2} />
          <h2 className="text-3xl md:text-4xl font-bold bg-gradient-to-r from-brand-800 to-brand-600 bg-clip-text text-transparent">
            {t('global_marketplace.title')}
          </h2>
        </div>
        <p className="text-gray-700 text-lg md:text-xl mb-12 max-w-2xl mx-auto">
          {t('global_marketplace.subtitle')}
        </p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-6 max-w-3xl mx-auto">
          {marketplaces.map((market) => (
            <Card key={market.label} className="bg-white shadow-sm hover:shadow-lg transition-shadow duration-300 border border-brand-100/50 group">
              <CardContent className="p-6 flex flex-col items-center justify-center">
                <span className="text-4xl mb-3 group-hover:scale-110 transition-transform duration-300">{market.icon}</span>
                <p className="text-sm font-medium text-gray-800 group-hover:text-brand-700 transition-colors">{market.label}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
};

export default GlobalMarketplaceSupport;
