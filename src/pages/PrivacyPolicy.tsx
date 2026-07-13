
import React from "react";
import { Helmet } from "react-helmet-async";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { formatDate } from "@/lib/utils";
import { useLanguage } from "@/contexts/LanguageContext";

const PrivacyPolicy = () => {
  const { t } = useLanguage();
  const today = formatDate(new Date(), "PPP"); // Format: April 6, 2025

  return (
    <div className="min-h-screen flex flex-col">
      <Helmet>
        <title>Privacy Policy | InventorySprint</title>
        <meta name="description" content="How InventorySprint collects, uses, and protects data for Amazon sellers using our arbitrage and repricing tools." />
        <meta name="keywords" content="InventorySprint privacy policy, amazon seller software privacy, data protection amazon sellers" />
        <link rel="canonical" href="https://inventorysprint.com/privacy" />
        <meta property="og:title" content="Privacy Policy | InventorySprint" />
        <meta property="og:description" content="How InventorySprint collects, uses, and protects your data." />
        <meta property="og:url" content="https://inventorysprint.com/privacy" />
      </Helmet>
      <Navbar />
      <main className="flex-grow pt-24 pb-16">
        <div className="container mx-auto px-4 max-w-4xl">
          <h1 id="privacy-policy" className="text-3xl md:text-4xl font-bold mb-6 gradient-text">{t('privacy_policy.title')}</h1>
          <p className="text-gray-600 mb-8">{t('privacy_policy.effective_date')}</p>
          <p className="font-medium text-xl mb-6">{t('privacy_policy.product')}</p>

          <p className="mb-6">
            {t('privacy_policy.intro')}
          </p>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4 flex items-center">
              <span className="text-2xl mr-2">🔑</span> {t('privacy_policy.section1_title')}
            </h2>
            <p className="mb-3">
              {t('privacy_policy.section1_content')}
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4 flex items-center">
              <span className="text-2xl mr-2">📂</span> {t('privacy_policy.section2_title')}
            </h2>
            <p className="mb-3">
              {t('privacy_policy.section2_content1')}
            </p>
            <p className="mb-3">
              {t('privacy_policy.section2_content2')}
            </p>
            <p className="mb-3">
              {t('privacy_policy.section2_content3')}
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4 flex items-center">
              <span className="text-2xl mr-2">🌐</span> {t('privacy_policy.section3_title')}
            </h2>
            <p className="mb-3">
              {t('privacy_policy.section3_content1')}
            </p>
            <p className="mb-3">
              {t('privacy_policy.section3_content2')}
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4 flex items-center">
              <span className="text-2xl mr-2">🔒</span> {t('privacy_policy.section4_title')}
            </h2>
            <p className="mb-3">
              {t('privacy_policy.section4_content')}
            </p>
            <ul className="list-disc pl-6 mb-3 space-y-2">
              <li>{t('privacy_policy.section4_item1')}</li>
              <li>{t('privacy_policy.section4_item2')}</li>
              <li>{t('privacy_policy.section4_item3')}</li>
            </ul>
            <p className="mb-3">
              {t('privacy_policy.section4_conclusion')}
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4 flex items-center">
              <span className="text-2xl mr-2">❌</span> {t('privacy_policy.section5_title')}
            </h2>
            <ul className="list-disc pl-6 mb-3 space-y-2">
              <li>{t('privacy_policy.section5_item1')}</li>
              <li>{t('privacy_policy.section5_item2')}</li>
              <li>{t('privacy_policy.section5_item3')}</li>
            </ul>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4 flex items-center">
              <span className="text-2xl mr-2">🍪</span> {t('privacy_policy.section6_title')}
            </h2>
            <p className="mb-3 font-bold">{t('privacy_policy.section6_subtitle')}</p>
            <p className="mb-3">
              {t('privacy_policy.section6_content')}
            </p>
            <ul className="list-disc pl-6 mb-3 space-y-2">
              <li>{t('privacy_policy.section6_item1')}</li>
              <li>{t('privacy_policy.section6_item2')}</li>
              <li>{t('privacy_policy.section6_item3')}</li>
              <li>{t('privacy_policy.section6_item4')}</li>
            </ul>
            <p className="mb-3">
              {t('privacy_policy.section6_conclusion')}
            </p>
            <div className="bg-blue-50 border-l-4 border-blue-500 p-4 mb-3">
              <p className="text-blue-800">
                <strong>{t('privacy_policy.section6_highlight_title')}</strong> {t('privacy_policy.section6_highlight_content')}
              </p>
            </div>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4 flex items-center">
              <span className="text-2xl mr-2">⚠️</span> {t('privacy_policy.section7_title')}
            </h2>
            <p className="mb-3">
              {t('privacy_policy.section7_content')}
            </p>
          </section>
        </div>
      </main>
      <Footer />
    </div>
  );
};

export default PrivacyPolicy;
