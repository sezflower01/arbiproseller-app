import React from "react";
import { Helmet } from "react-helmet-async";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import {
  Library,
  Link2,
  RefreshCw,
  Bell,
  CheckCircle2,
  Package,
  ClipboardList,
} from "lucide-react";

const ProductLibraryProduct: React.FC = () => {
  const navigate = useNavigate();

  const handleSubscribe = () => {
    if (typeof window.gtag !== "undefined") {
      window.gtag("event", "cta_click", {
        event_category: "conversion",
        event_label: "product_library_subscribe",
      });
    }
    navigate("/subscriptions");
  };

  const features = [
    {
      icon: Library,
      title: "Store Proven Products",
      desc: "Build your private database of winners. Every ASIN, every detail, in one place.",
    },
    {
      icon: Link2,
      title: "Supplier Tracking",
      desc: "Save direct supplier links and product history for one-click reordering.",
    },
    {
      icon: RefreshCw,
      title: "Reordering Workflow",
      desc: "Move from 'need to restock' to 'order placed' in seconds.",
    },
    {
      icon: Bell,
      title: "Never Run Out",
      desc: "Smart alerts based on velocity, stock and inbound — so you reorder before it's too late.",
    },
    {
      icon: ClipboardList,
      title: "Full Product History",
      desc: "Track every purchase, cost change, and supplier swap over time.",
    },
  ];

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Helmet>
        <title>Product Library — Your Amazon Product Database</title>
        <meta
          name="description"
          content="Organize proven Amazon products, track suppliers, and reorder faster. Stop losing time searching — keep everything in one place and act faster."
        />
        <meta name="keywords" content="amazon product library, FBA sourcing database, amazon supplier tracking, amazon inventory management, inventory sprint product library" />
        <link
          rel="canonical"
          href="https://inventorysprint.com/products/product-library"
        />
      </Helmet>

      <Navbar />

      {/* Hero */}
      <section className="pt-32 pb-20 px-4 bg-gradient-to-b from-[hsl(222,84%,4.9%)] via-[hsl(222,84%,6%)] to-[hsl(222,84%,4.9%)]">
        <div className="container mx-auto max-w-5xl text-center">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border border-primary/30 bg-primary/10 mb-6">
            <Package className="h-3.5 w-3.5 text-primary" />
            <span className="text-xs font-semibold uppercase tracking-wider text-primary">
              Product Library
            </span>
          </div>
          <h1 className="text-4xl md:text-6xl font-bold mb-6 bg-gradient-to-r from-white to-white/70 bg-clip-text text-transparent">
            Your Amazon
            <br />
            Product Database.
          </h1>
          <p className="text-lg md:text-xl text-muted-foreground mb-4 max-w-2xl mx-auto">
            Organize proven products, track suppliers, and reorder faster. Stop losing time
            searching — keep everything in one place and act faster.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center items-center mt-8">
            <Button size="lg" className="text-base px-8" onClick={handleSubscribe}>
              Subscribe to Product Library
            </Button>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="py-20 px-4">
        <div className="container mx-auto max-w-6xl">
          <div className="text-center mb-12">
            <h2 className="text-3xl md:text-4xl font-bold mb-3">
              Everything you need to stay organized
            </h2>
            <p className="text-muted-foreground">
              Built as a system for serious sellers who want to scale.
            </p>
          </div>
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-5">
            {features.map((f) => (
              <div
                key={f.title}
                className="p-6 rounded-xl border border-white/10 bg-card/40 hover:border-primary/30 transition-colors"
              >
                <div className="h-10 w-10 rounded-lg bg-primary/15 flex items-center justify-center mb-4">
                  <f.icon className="h-5 w-5 text-primary" />
                </div>
                <h3 className="text-base font-semibold mb-2">{f.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>


      {/* Bottom CTA */}
      <section className="py-20 px-4 text-center">
        <div className="container mx-auto max-w-3xl">
          <h2 className="text-3xl md:text-4xl font-bold mb-4">
            Stop searching. Start organizing.
          </h2>
          <p className="text-muted-foreground mb-8">
            Get full access to the Product Library and turn chaos into a system.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <Button size="lg" className="text-base px-8" onClick={handleSubscribe}>
              Subscribe to Product Library
            </Button>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <CheckCircle2 className="h-4 w-4 text-primary" />
              <span>Built for serious Amazon sellers</span>
            </div>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
};

export default ProductLibraryProduct;
