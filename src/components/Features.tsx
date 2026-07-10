
import { useIsMobile } from "@/hooks/use-mobile";
import { useLanguage } from "@/contexts/LanguageContext";
import { Database, Users, Package, Shield, FileText, RefreshCw, Download, BarChart3 } from "lucide-react";

const Features = () => {
  const isMobile = useIsMobile();
  const { t } = useLanguage();

  const features = [
    {
      title: t('features.product_research_title'),
      description: t('features.product_research_description'),
      icon: Database,
      color: 'from-blue-500 to-blue-600'
    },
    {
      title: t('features.supplier_management_title'),
      description: t('features.supplier_management_description'),
      icon: Users,
      color: 'from-green-500 to-green-600'
    },
    {
      title: t('features.inventory_tracker_title'),
      description: t('features.inventory_tracker_description'),
      icon: Package,
      color: 'from-purple-500 to-purple-600'
    },
    {
      title: t('features.automatic_backups_title'),
      description: t('features.automatic_backups_description'),
      icon: Shield,
      color: 'from-orange-500 to-orange-600'
    },
    {
      title: t('features.draft_title'),
      description: t('features.draft_description'),
      icon: FileText,
      color: 'from-cyan-500 to-cyan-600'
    },
    {
      title: t('features.reordering_decision_title'),
      description: t('features.reordering_decision_description'),
      icon: RefreshCw,
      color: 'from-indigo-500 to-indigo-600'
    },
    {
      title: t('features.import_export_title'),
      description: t('features.import_export_description'),
      icon: Download,
      color: 'from-teal-500 to-teal-600'
    },
    {
      title: t('features.business_insights_title'),
      description: t('features.business_insights_description'),
      icon: BarChart3,
      color: 'from-rose-500 to-rose-600'
    }
  ];

  return (
    <section id="features" className="py-20 bg-gray-50">
      <div className="container mx-auto px-4">
        <div className="text-center max-w-3xl mx-auto mb-16">
          <h2 className="text-3xl md:text-4xl font-bold mb-4">
            {t('features.title')} <span className="bg-gradient-to-r from-brand-700 to-brand-900 bg-clip-text text-transparent">{t('features.title_amazon_sellers')}</span>
          </h2>
          <p className="text-gray-600 text-lg">
            {t('features.subtitle')}
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
          {features.map((feature, index) => {
            const IconComponent = feature.icon;
            return (
              <div 
                key={index} 
                className="bg-white p-8 rounded-xl shadow-sm border border-brand-100/50 hover:shadow-md hover:border-brand-200 transition-all duration-300 group"
              >
                <div className={`inline-flex items-center justify-center w-12 h-12 rounded-lg bg-gradient-to-r ${feature.color} mb-5 group-hover:scale-110 transition-transform duration-300`}>
                  <IconComponent className="w-6 h-6 text-white" />
                </div>
                <h3 className="text-xl font-semibold mb-3 text-brand-900">{feature.title}</h3>
                <p className="text-gray-700 group-hover:text-brand-800 transition-colors whitespace-pre-line">{feature.description}</p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
};

export default Features;
