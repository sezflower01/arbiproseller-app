
import React from 'react';
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Helmet } from "react-helmet-async";
import { Mail } from 'lucide-react';

const Support = () => {
  return (
    <>
      <Helmet>
        <title>Support | InventorySprint</title>
        <meta name="description" content="Get support for InventorySprint. Contact our team for inquiries about our Amazon arbitrage and repricer tools." />
        <meta name="keywords" content="InventorySprint support, amazon FBA software help, amazon seller tools support, amazon inventory software support" />
        <link rel="canonical" href="https://inventorysprint.com/support" />
        <meta property="og:title" content="Support | InventorySprint" />
        <meta property="og:description" content="Help and support for InventorySprint users." />
        <meta property="og:url" content="https://inventorysprint.com/support" />
        <meta name="twitter:title" content="Support | InventorySprint" />
        <meta name="twitter:description" content="Help and support for InventorySprint users." />
      </Helmet>
      
      <div className="min-h-screen flex flex-col">
        <Navbar />
        
        <main className="flex-grow container mx-auto px-4 py-16">
          <div className="max-w-2xl mx-auto text-center">
            <h1 className="text-4xl font-bold mb-8 bg-gradient-to-r from-blue-800 to-blue-600 bg-clip-text text-transparent">
              Support
            </h1>
            
            <div className="bg-white shadow-md rounded-lg p-8">
              <Mail className="mx-auto h-12 w-12 text-blue-600 mb-4" />
              <h2 className="text-2xl font-semibold mb-4">Need Help?</h2>
              <p className="text-gray-700 mb-6">
                For any inquiries, please send an email to:
              </p>
              <a 
                href="mailto:support@arbiproseller.com" 
                className="text-blue-600 text-xl font-bold hover:underline"
              >
                support@arbiproseller.com
              </a>
              <p className="text-gray-500 mt-4">
                Our support team will respond to your email as soon as possible.
              </p>
            </div>
          </div>
        </main>
        
        <Footer />
      </div>
    </>
  );
};

export default Support;
