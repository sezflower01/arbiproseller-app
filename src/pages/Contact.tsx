
import React from 'react';
import Navbar from "@/components/Navbar";
import ContactForm from "@/components/ContactForm";
import Footer from "@/components/Footer";
import { Helmet } from "react-helmet-async";
import { useLanguage } from "@/contexts/LanguageContext";

const Contact = () => {
  const { t } = useLanguage();
  
  return (
    <>
      <Helmet>
        <title>Contact ArbiProSeller - Get in Touch</title>
        <meta name="description" content="Contact ArbiProSeller support team. We're here to help you with any questions about our Amazon seller database software." />
        <link rel="canonical" href="https://arbiproseller.com/contact" />
        <meta property="og:title" content="Contact ArbiProSeller" />
        <meta property="og:description" content="Get in touch with the ArbiProSeller team." />
        <meta property="og:url" content="https://arbiproseller.com/contact" />
        <meta name="twitter:title" content="Contact ArbiProSeller" />
        <meta name="twitter:description" content="Get in touch with the ArbiProSeller team." />
        <script type="application/ld+json">{`
          {
            "@context": "https://schema.org",
            "@type": "ContactPage",
            "url": "https://arbiproseller.com/contact",
            "name": "Contact ArbiProSeller",
            "description": "Get in touch with ArbiProSeller for support or inquiries about our Amazon seller database software.",
            "isPartOf": {
              "@type": "WebSite",
              "name": "ArbiProSeller",
              "url": "https://arbiproseller.com/"
            }
          }
        `}</script>
      </Helmet>
      
      <div className="min-h-screen flex flex-col">
        <Navbar />
        
        <main className="flex-grow">
          <section className="container mx-auto px-4 py-16">
            <div className="max-w-2xl mx-auto">
              <h1 className="text-4xl font-bold mb-8 text-center bg-gradient-to-r from-blue-800 to-blue-600 bg-clip-text text-transparent">
                {t('contact.title')}
              </h1>
              
              <ContactForm />
            </div>
          </section>
        </main>
        
        <Footer />
      </div>
    </>
  );
};

export default Contact;
