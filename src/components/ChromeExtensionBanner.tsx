import { Puzzle, Search, FilePlus, Printer } from "lucide-react";
import { toast } from "sonner";

async function triggerDownload(url: string, filename: string) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
    toast.success(`Downloading ${filename}…`);
  } catch (err: any) {
    toast.error(`Download failed: ${err.message || err}`);
  }
}

const ChromeExtensionBanner = () => {
  return (
    <section className="relative overflow-hidden py-16 md:py-20">
      <div className="absolute inset-0 bg-gradient-to-r from-[hsl(28,70%,10%)] via-[hsl(20,65%,12%)] to-[hsl(35,60%,10%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_30%_50%,hsl(28,80%,50%,0.15),transparent_60%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_70%_50%,hsl(35,70%,50%,0.1),transparent_60%)]" />

      <div
        className="absolute inset-0 opacity-[0.04]"
        style={{
          backgroundImage:
            "linear-gradient(hsl(28,60%,50%) 1px, transparent 1px), linear-gradient(90deg, hsl(28,60%,50%) 1px, transparent 1px)",
          backgroundSize: "60px 60px",
        }}
      />

      <div className="container mx-auto px-4 relative z-10">
        <div className="max-w-4xl mx-auto text-center space-y-8">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-amber-500/15 border border-amber-400/25 text-amber-400 text-sm font-medium backdrop-blur-sm">
            <Puzzle className="w-4 h-4" />
            Browser Extension — Available Now
          </div>

          <h2 className="text-3xl md:text-5xl lg:text-6xl font-bold tracking-tight text-white">
            Built for your daily workflow.
          </h2>

          <p className="text-lg md:text-xl text-white/90 max-w-2xl mx-auto leading-relaxed">
            One extension that stays with you on Amazon — scan and analyze products while you source, then create the listing without ever switching tabs.
          </p>

          <div className="flex flex-wrap justify-center gap-4 pt-4">
            <div className="flex items-center gap-2.5 px-5 py-3 rounded-xl bg-white/[0.04] border border-white/[0.08] backdrop-blur-sm">
              <div className="p-1.5 rounded-lg bg-amber-500/15">
                <Search className="w-4 h-4 text-amber-400" />
              </div>
              <span className="text-sm font-medium text-white/90">Source & Analyze</span>
            </div>
            <div className="flex items-center gap-2.5 px-5 py-3 rounded-xl bg-white/[0.04] border border-white/[0.08] backdrop-blur-sm">
              <div className="p-1.5 rounded-lg bg-orange-500/15">
                <FilePlus className="w-4 h-4 text-orange-400" />
              </div>
              <span className="text-sm font-medium text-white/90">Create Listings</span>
            </div>
            <div className="flex items-center gap-2.5 px-5 py-3 rounded-xl bg-white/[0.04] border border-white/[0.08] backdrop-blur-sm">
              <div className="p-1.5 rounded-lg bg-yellow-500/15">
                <Printer className="w-4 h-4 text-yellow-400" />
              </div>
              <span className="text-sm font-medium text-white/90">Print Labels</span>
            </div>
          </div>

          <div className="flex flex-wrap justify-center gap-3 pt-2">
            <button
              onClick={() => triggerDownload("/arbiproseller-extension.zip", "arbiproseller-extension.zip")}
              className="px-5 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-black font-semibold text-sm transition-colors"
            >
              Download Analyzer Extension
            </button>
            <button
              onClick={() => triggerDownload("/arbiproseller-create-listing-extension.zip", "arbiproseller-create-listing-extension.zip")}
              className="px-5 py-2.5 rounded-xl border border-amber-400/30 hover:bg-white/5 text-white font-semibold text-sm transition-colors"
            >
              Download Create Listing Extension
            </button>
          </div>
        </div>
      </div>
    </section>
  );
};

export default ChromeExtensionBanner;
