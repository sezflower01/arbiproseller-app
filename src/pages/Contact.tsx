
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
        <title>Contact InventorySprint - Get in Touch</title>
        <meta name="description" content="Contact InventorySprint support team. We're here to help you with any questions about our Amazon seller database software." />
        <meta name="keywords" content="contact InventorySprint, amazon seller software support, amazon FBA tools contact" />
        <link rel="canonical" href="https://inventorysprint.com/contact" />
        <meta property="og:title" content="Contact InventorySprint" />
        <meta property="og:description" content="Get in touch with the InventorySprint team." />
        <meta property="og:url" content="https://inventorysprint.com/contact" />
        <meta name="twitter:title" content="Contact InventorySprint" />
        <meta name="twitter:description" content="Get in touch with the InventorySprint team." />
        <script type="application/ld+json">{`
          {
            "@context": "https://schema.org",
            "@type": "ContactPage",
            "url": "https://inventorysprint.com/contact",
            "name": "Contact InventorySprint",
            "description": "Get in touch with InventorySprint for support or inquiries about our Amazon seller database software.",
            "isPartOf": {
              "@type": "WebSite",
              "name": "InventorySprint",
              "url": "https://inventorysprint.com/"
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
