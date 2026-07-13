
import React from 'react';
import Footer from '../components/Footer';
import Navbar from '../components/Navbar';
import { Helmet } from 'react-helmet-async';
import { useLanguage } from '@/contexts/LanguageContext';

const About = () => {
  const { t } = useLanguage();

  return (
    <div className="min-h-screen bg-gray-50">
      <Helmet>
        <title>{t('about.title')}</title>
        <meta name="description" content={t('about.subtitle')} />
        <meta name="keywords" content="InventorySprint, amazon seller software company, amazon FBA tools, amazon inventory management software" />
        <link rel="canonical" href="https://inventorysprint.com/about" />
        <meta property="og:title" content={t('about.title')} />
        <meta property="og:description" content={t('about.subtitle')} />
        <meta property="og:url" content="https://inventorysprint.com/about" />
      </Helmet>
      
      <Navbar />
      
      <main className="container mx-auto px-4 py-16">
        <div className="max-w-4xl mx-auto">
          <h1 className="text-4xl font-bold text-gray-900 mb-8 text-center">{t('about.title')}</h1>
          
          <div className="space-y-8 text-gray-600">
            <section className="bg-white p-8 rounded-lg shadow-sm">
              <h2 className="text-2xl font-semibold text-gray-800 mb-4">{t('about.story_title')}</h2>
              <p className="leading-relaxed">
                {t('about.story_content')}
              </p>
            </section>

            <section className="bg-white p-8 rounded-lg shadow-sm">
              <h2 className="text-2xl font-semibold text-gray-800 mb-4">{t('about.mission_title')}</h2>
              <p className="leading-relaxed">
                {t('about.mission_content')}
              </p>
            </section>

            <section className="bg-white p-8 rounded-lg shadow-sm">
              <h2 className="text-2xl font-semibold text-gray-800 mb-4">{t('about.features_title')}</h2>
              <p className="leading-relaxed mb-4">
                {t('about.features_title')}:
              </p>
              <ul className="list-disc list-inside space-y-2 ml-4">
                <li>{t('about.feature1')}</li>
                <li>{t('about.feature2')}</li>
                <li>{t('about.feature3')}</li>
                <li>{t('about.feature4')}</li>
              </ul>
            </section>

            <section className="bg-white p-8 rounded-lg shadow-sm">
              <h2 className="text-2xl font-semibold text-gray-800 mb-4">{t('about.contact_title')}</h2>
              <p className="leading-relaxed">
                {t('about.contact_content')}
              </p>
            </section>
          </div>
        </div>
      </main>
      
      <Footer />
    </div>
  );
};

export default About;
