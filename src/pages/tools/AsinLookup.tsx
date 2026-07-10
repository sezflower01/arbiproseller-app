import { Helmet } from "react-helmet-async";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";

const AsinLookup = () => {
  return (
    <div className="min-h-screen flex flex-col">
      <Helmet>
        <title>ASIN Title & Image Lookup | ArbiProSeller</title>
        <meta name="description" content="Look up product title and images by ASIN" />
      </Helmet>
      
      <Navbar />
      
      <main className="flex-grow pt-24 pb-12">
        <div className="container mx-auto px-4">
          <h1 className="text-4xl font-bold mb-4">ASIN Title & Image Lookup</h1>
          <p className="text-xl text-muted-foreground mb-8">
            Look up product title and images by ASIN
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

export default AsinLookup;
