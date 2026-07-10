import React from "react";
import { PlusCircle, FileCheck, ShieldCheck, Boxes } from "lucide-react";

const CreateListingBanner = () => {
  return (
    <section className="relative overflow-hidden py-16 md:py-20">
      <div className="absolute inset-0 bg-gradient-to-r from-[hsl(150,55%,8%)] via-[hsl(165,50%,11%)] to-[hsl(140,55%,8%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_30%_50%,hsl(150,70%,40%,0.12),transparent_60%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_70%_50%,hsl(165,60%,45%,0.1),transparent_60%)]" />

      <div
        className="absolute inset-0 opacity-[0.04]"
        style={{
          backgroundImage:
            "linear-gradient(hsl(150,60%,45%) 1px, transparent 1px), linear-gradient(90deg, hsl(150,60%,45%) 1px, transparent 1px)",
          backgroundSize: "60px 60px",
        }}
      />

      <div className="container mx-auto px-4 relative z-10">
        <div className="max-w-4xl mx-auto text-center space-y-8">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-green-500/15 border border-green-400/25 text-green-400 text-sm font-medium backdrop-blur-sm">
            <PlusCircle className="w-4 h-4" />
            Create Listing — Grow Your Catalog
          </div>

          <h2 className="text-3xl md:text-5xl lg:text-6xl font-bold tracking-tight text-white">
            Add new products to your database and Amazon — in one step.
          </h2>

          <p className="text-lg md:text-xl text-muted-foreground/90 max-w-2xl mx-auto leading-relaxed">
            Enter an ASIN and the system auto-fetches product data, calculates Amazon fees, checks gating status, and records your cost — ready for repricing instantly.
          </p>

          <div className="flex flex-wrap justify-center gap-4 pt-4">
            <div className="flex items-center gap-2.5 px-5 py-3 rounded-xl bg-white/[0.04] border border-white/[0.08] backdrop-blur-sm">
              <div className="p-1.5 rounded-lg bg-green-500/15">
                <FileCheck className="w-4 h-4 text-green-400" />
              </div>
              <span className="text-sm font-medium text-white/90">Auto-Fetch Product Data</span>
            </div>
            <div className="flex items-center gap-2.5 px-5 py-3 rounded-xl bg-white/[0.04] border border-white/[0.08] backdrop-blur-sm">
              <div className="p-1.5 rounded-lg bg-emerald-500/15">
                <ShieldCheck className="w-4 h-4 text-emerald-400" />
              </div>
              <span className="text-sm font-medium text-white/90">Fee & Gating Check</span>
            </div>
            <div className="flex items-center gap-2.5 px-5 py-3 rounded-xl bg-white/[0.04] border border-white/[0.08] backdrop-blur-sm">
              <div className="p-1.5 rounded-lg bg-teal-500/15">
                <Boxes className="w-4 h-4 text-teal-400" />
              </div>
              <span className="text-sm font-medium text-white/90">Cost & Purchase Tracking</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default CreateListingBanner;
