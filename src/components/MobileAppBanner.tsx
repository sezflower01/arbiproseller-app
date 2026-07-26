import { Smartphone, Radio, ScanLine, Wallet } from "lucide-react";

const MobileAppBanner = () => {
  return (
    <section className="relative overflow-hidden py-16 md:py-20">
      <div className="absolute inset-0 bg-gradient-to-r from-[hsl(210,70%,10%)] via-[hsl(200,65%,12%)] to-[hsl(220,60%,10%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_30%_50%,hsl(200,80%,50%,0.15),transparent_60%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_70%_50%,hsl(220,70%,50%,0.1),transparent_60%)]" />

      <div
        className="absolute inset-0 opacity-[0.04]"
        style={{
          backgroundImage:
            "linear-gradient(hsl(200,60%,50%) 1px, transparent 1px), linear-gradient(90deg, hsl(200,60%,50%) 1px, transparent 1px)",
          backgroundSize: "60px 60px",
        }}
      />

      <div className="container mx-auto px-4 relative z-10">
        <div className="max-w-4xl mx-auto text-center space-y-8">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-sky-500/15 border border-sky-400/25 text-sky-400 text-sm font-medium backdrop-blur-sm">
            <Smartphone className="w-4 h-4" />
            Mobile App — Coming Soon
          </div>

          <h2 className="text-3xl md:text-5xl lg:text-6xl font-bold tracking-tight text-white">
            Your business, in your pocket.
          </h2>

          <p className="text-lg md:text-xl text-white/90 max-w-2xl mx-auto leading-relaxed">
            We're building a mobile app so you can run your Amazon business from anywhere — check today's sales, scan a barcode on the spot, and see what your inventory is really worth.
          </p>

          <div className="flex flex-wrap justify-center gap-4 pt-4">
            <div className="flex items-center gap-2.5 px-5 py-3 rounded-xl bg-white/[0.04] border border-white/[0.08] backdrop-blur-sm">
              <div className="p-1.5 rounded-lg bg-sky-500/15">
                <Radio className="w-4 h-4 text-sky-400" />
              </div>
              <span className="text-sm font-medium text-white/90">Live Sales</span>
            </div>
            <div className="flex items-center gap-2.5 px-5 py-3 rounded-xl bg-white/[0.04] border border-white/[0.08] backdrop-blur-sm">
              <div className="p-1.5 rounded-lg bg-blue-500/15">
                <ScanLine className="w-4 h-4 text-blue-400" />
              </div>
              <span className="text-sm font-medium text-white/90">Barcode Scanner</span>
            </div>
            <div className="flex items-center gap-2.5 px-5 py-3 rounded-xl bg-white/[0.04] border border-white/[0.08] backdrop-blur-sm">
              <div className="p-1.5 rounded-lg bg-indigo-500/15">
                <Wallet className="w-4 h-4 text-indigo-400" />
              </div>
              <span className="text-sm font-medium text-white/90">Live Inventory Valuation</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default MobileAppBanner;
