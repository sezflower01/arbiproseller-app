
import React from 'react';
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Helmet } from "react-helmet-async";
import { Mail } from 'lucide-react';

const Support = () => {
  return (
    <>
      <Helmet>
        <title>Support | ArbiProSeller</title>
        <meta name="description" content="Get support for ArbiProSeller. Contact our team for inquiries about our Amazon arbitrage and repricer tools." />
        <link rel="canonical" href="https://arbiproseller.com/support" />
        <meta property="og:title" content="Support | ArbiProSeller" />
        <meta property="og:description" content="Help and support for ArbiProSeller users." />
        <meta property="og:url" content="https://arbiproseller.com/support" />
        <meta name="twitter:title" content="Support | ArbiProSeller" />
        <meta name="twitter:description" content="Help and support for ArbiProSeller users." />
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
