import { Helmet } from "react-helmet-async";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";

const BreakEvenCalculator = () => {
  return (
    <div className="min-h-screen flex flex-col">
      <Helmet>
        <title>Break-even Calculator | ArbiProSeller</title>
        <meta name="description" content="Calculate break-even points for your Amazon FBA products" />
      </Helmet>
      
      <Navbar />
      
      <main className="flex-grow pt-24 pb-12">
        <div className="container mx-auto px-4">
          <h1 className="text-4xl font-bold mb-4">Break-even Calculator</h1>
          <p className="text-xl text-muted-foreground mb-8">
            Calculate break-even points for your Amazon FBA products
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

export default BreakEvenCalculator;
