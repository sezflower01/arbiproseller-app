import { Helmet } from "react-helmet-async";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";

const UpcToAsin = () => {
  return (
    <div className="min-h-screen flex flex-col">
      <Helmet>
        <title>UPC/EAN to ASIN Converter | ArbiProSeller</title>
        <meta name="description" content="Convert UPC or EAN codes to ASIN" />
      </Helmet>
      
      <Navbar />
      
      <main className="flex-grow pt-24 pb-12">
        <div className="container mx-auto px-4">
          <h1 className="text-4xl font-bold mb-4">UPC/EAN → ASIN Converter</h1>
          <p className="text-xl text-muted-foreground mb-8">
            Convert UPC or EAN codes to ASIN
          </p>
          
          <div className="max-w-2xl mx-auto p-8 border rounded-lg bg-card">
            <p className="text-center text-muted-foreground">
              Tool implementation coming soon...
            </p>
          </div>
        </div>
      </main>
      
      <Footer />
    </div>
  );
};

export default UpcToAsin;
