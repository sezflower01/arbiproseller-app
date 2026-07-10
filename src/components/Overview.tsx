
import React from 'react';
import EssentialFeatures from './overview/EssentialFeatures';
import SellerChallenges from './overview/SellerChallenges';
import { LucideCheckCircle } from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';

const Overview = () => {
  const { t } = useLanguage();

  return (
    <section id="overview" className="py-20 bg-white">
      <div className="container mx-auto px-4">
        <div className="text-center max-w-3xl mx-auto mb-16">
          <div className="flex items-center justify-center mb-4">
            <LucideCheckCircle className="text-brand-500 w-8 h-8 mr-3" strokeWidth={2} />
            <h2 className="text-3xl md:text-4xl font-bold bg-gradient-to-r from-brand-800 to-brand-600 bg-clip-text text-transparent">
              {t('overview.title')}
            </h2>
          </div>
          <p className="text-gray-700 text-lg leading-relaxed max-w-2xl mx-auto">
            {t('overview.subtitle')}
          </p>
        </div>

        {/* Essential Features Section */}
        <EssentialFeatures />

        <div className="mb-16">          
          <SellerChallenges />
        </div>
      </div>
    </section>
  );
};

export default Overview;
