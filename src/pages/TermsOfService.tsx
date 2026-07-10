
import React from "react";
import { Helmet } from "react-helmet-async";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { formatDate } from "@/lib/utils";
import { useLanguage } from "@/contexts/LanguageContext";

const TermsOfService = () => {
  const { t } = useLanguage();
  const today = formatDate(new Date(), "PPP"); // Format: April 7, 2025

  return (
    <div className="min-h-screen flex flex-col">
      <Helmet>
        <title>Terms of Service | ArbiProSeller</title>
        <meta name="description" content="Terms governing use of ArbiProSeller's Amazon arbitrage software, repricer, and seller tools." />
        <link rel="canonical" href="https://arbiproseller.com/terms" />
        <meta property="og:title" content="Terms of Service | ArbiProSeller" />
        <meta property="og:description" content="Terms governing use of ArbiProSeller's seller tools." />
        <meta property="og:url" content="https://arbiproseller.com/terms" />
      </Helmet>
      <Navbar />
      <main className="flex-grow pt-24 pb-16">
        <div className="container mx-auto px-4 max-w-4xl">
          <h1 id="terms-of-service" className="text-3xl md:text-4xl font-bold mb-6 gradient-text">{t('terms_of_service.title')}</h1>
          <p className="text-gray-600 mb-8">{t('terms_of_service.effective_date')}</p>
          <p className="font-medium text-xl mb-6">{t('terms_of_service.product')}</p>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">{t('terms_of_service.section1_title')}</h2>
            <p className="mb-3">
              {t('terms_of_service.section1_content')}
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">{t('terms_of_service.section2_title')}</h2>
            <p className="mb-3">
              {t('terms_of_service.section2_content')}
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">{t('terms_of_service.section3_title')}</h2>
            <p className="mb-3">
              {t('terms_of_service.section3_content')}
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">{t('terms_of_service.section4_title')}</h2>
            <p className="mb-3">
              {t('terms_of_service.section4_content')}
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">{t('terms_of_service.section5_title')}</h2>
            <p className="mb-3">
              {t('terms_of_service.section5_content')}
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">{t('terms_of_service.section6_title')}</h2>
            <p className="mb-3">
              {t('terms_of_service.section6_content')}
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">{t('terms_of_service.section7_title')}</h2>
            <p className="mb-3">
              {t('terms_of_service.section7_content')}
            </p>
            <ul className="list-disc pl-6 mb-3 space-y-2">
              <li>{t('terms_of_service.section7_item1')}</li>
              <li>{t('terms_of_service.section7_item2')}</li>
              <li>{t('terms_of_service.section7_item3')}</li>
              <li>{t('terms_of_service.section7_item4')}</li>
            </ul>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">{t('terms_of_service.section8_title')}</h2>
            <p className="mb-3">
              {t('terms_of_service.section8_content')}
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">{t('terms_of_service.section9_title')}</h2>
            <p className="mb-3">
              {t('terms_of_service.section9_content')}
            </p>
          </section>

          <section className="mb-8">
            <h2 className="text-2xl font-semibold mb-4">{t('terms_of_service.section10_title')}</h2>
            <p className="mb-3">
              {t('terms_of_service.section10_content')}
            </p>
            <p className="flex items-center mb-3">
              <span className="mr-2">📧</span>
              <a href="mailto:support@arbiproseller.com" className="text-blue-600 hover:underline">{t('terms_of_service.contact_email')}</a>
            </p>
          </section>
        </div>
      </main>
      <Footer />
    </div>
  );
};

export default TermsOfService;
