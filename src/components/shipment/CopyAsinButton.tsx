import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";

interface CopyAsinButtonProps {
  asin: string;
}

/**
 * Small 3D press-style square button to copy an ASIN to the clipboard.
 */
export function CopyAsinButton({ asin }: CopyAsinButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(asin);
      setCopied(true);
      toast.success(`Copied ${asin}`);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      toast.error("Failed to copy");
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={`Copy ${asin}`}
      aria-label={`Copy ASIN ${asin}`}
      className="
        inline-flex items-center justify-center
        h-5 w-5 rounded
        bg-gradient-to-b from-slate-100 to-slate-300
        text-slate-700
        border border-slate-400/60
        shadow-[0_2px_0_0_rgba(0,0,0,0.35),0_1px_2px_rgba(0,0,0,0.2),inset_0_1px_0_rgba(255,255,255,0.6)]
        transition-all duration-75
        hover:from-white hover:to-slate-200
        active:translate-y-[2px]
        active:shadow-[0_0_0_0_rgba(0,0,0,0.35),inset_0_1px_2px_rgba(0,0,0,0.25)]
        focus:outline-none focus:ring-2 focus:ring-blue-400
      "
    >
      {copied ? <Check className="h-3 w-3 text-green-600" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}
