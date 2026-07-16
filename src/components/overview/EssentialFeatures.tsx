
import React from 'react';
import FeatureCard from './FeatureCard';
import { useLanguage } from '@/contexts/LanguageContext';

const ICON_SRC = '/logo-icon.png';

const EssentialFeatures = () => {
  const { t } = useLanguage();

  const features = [
    {
      title: t('overview.smart_sourcing_title'),
      description: t('overview.smart_sourcing_description'),
      color: "bg-brand-100 text-brand-600"
    },
    {
      title: t('overview.amazon_shipment_title'),
      description: t('overview.amazon_shipment_description'),
      color: "bg-blue-100 text-blue-600"
    },
    {
      title: t('overview.image_link_title'),
      description: t('overview.image_link_description'),
      color: "bg-indigo-100 text-indigo-600"
    },
    {
      title: t('overview.order_flagging_title'),
      description: t('overview.order_flagging_description'),
      color: "bg-blue-100 text-blue-600"
    },
    {
      title: t('overview.monthly_yearly_title'),
      description: t('overview.monthly_yearly_description'),
      color: "bg-indigo-100 text-indigo-600"
    },
    {
      title: t('overview.search_compare_title'),
      description: t('overview.search_compare_description'),
      color: "bg-brand-100 text-brand-600"
    },
    {
      title: t('overview.backup_restore_title'),
      description: t('overview.backup_restore_description'),
      color: "bg-blue-100 text-blue-600"
    }
  ];

  return (
    <div className="mb-20">
      <h3 className="text-2xl font-bold mb-8 text-center bg-gradient-to-r from-brand-800 to-brand-600 bg-clip-text text-transparent">
        {t('overview.essential_features_title')}
      </h3>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {features.map((feature, index) => (
          <FeatureCard 
            key={index}
            title={feature.title}
            description={feature.description}
            color={feature.color}
          />
        ))}
      </div>
    </div>
  );
};

export default EssentialFeatures;
