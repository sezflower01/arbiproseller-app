
import React, { useEffect } from "react";
import { Helmet } from "react-helmet-async";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";

interface IndexPageLayoutProps {
  children: React.ReactNode;
  metaTitle: string;
  metaDescription: string;
}

const IndexPageLayout = ({ children, metaTitle, metaDescription }: IndexPageLayoutProps) => {
  useEffect(() => {
    // Track page view
    if (typeof gtag !== 'undefined') {
      gtag('config', 'GA_MEASUREMENT_ID', {
        page_title: metaTitle,
        page_location: window.location.href
      });
    }
  }, [metaTitle]);

  return (
    <div className="min-h-screen flex flex-col">
      <Helmet>
        <title>{metaTitle}</title>
        <meta name="description" content={metaDescription} />
        <link rel="canonical" href="https://arbiproseller.com/" />
        
        {/* Google Analytics 4 */}
        <script async src="https://www.googletagmanager.com/gtag/js?id=GA_MEASUREMENT_ID"></script>
        <script>
          {`
            window.dataLayer = window.dataLayer || [];
            function gtag(){dataLayer.push(arguments);}
            gtag('js', new Date());
            gtag('config', 'GA_MEASUREMENT_ID', {
              page_title: '${metaTitle}',
              page_location: window.location.href,
              send_page_view: true
            });
          `}
        </script>
        
        <script type="application/ld+json">{`
          {
            "@context": "https://schema.org",
            "@type": "SoftwareApplication",
            "name": "ArbiProSeller",
            "applicationCategory": "BusinessApplication",
            "operatingSystem": "Windows",
            "description": "Database software for Amazon sellers to track and manage product sourcing decisions",
            "url": "https://arbiproseller.com/",
            "downloadUrl": "https://arbiproseller.com/download",
            "softwareVersion": "2.0",
            "offers": {
              "@type": "Offer",
              "price": "0",
              "priceCurrency": "USD",
              "description": "60-day free autopilot trial"
            },
            "author": {
              "@type": "Organization",
              "name": "ArbiProSeller"
            },
            "screenshot": "https://arbiproseller.com/lovable-uploads/b8ba423b-b572-442e-9aea-856f91ca576d.png"
          }
        `}</script>
      </Helmet>
      
      <Navbar />
      <main className="flex-grow">
        {children}
      </main>
      <Footer />
    </div>
  );
};

export default IndexPageLayout;
