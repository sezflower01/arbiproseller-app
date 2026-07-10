import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

const ScrollIndicator = () => {
  const [isNearBottom, setIsNearBottom] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      const scrollPosition = window.scrollY + window.innerHeight;
      const documentHeight = document.documentElement.scrollHeight;
      // Consider "near bottom" when within 200px of page end
      setIsNearBottom(scrollPosition >= documentHeight - 200);
    };
    handleScroll();
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  const handleClick = () => {
    if (isNearBottom) {
      window.scrollTo({ top: 0, behavior: "smooth" });
    } else {
      window.scrollBy({ top: window.innerHeight * 0.9, behavior: "smooth" });
    }
  };

  return (
    <button
      onClick={handleClick}
      aria-label={isNearBottom ? "Scroll to top" : "Scroll down"}
      className="fixed bottom-6 left-3 z-40 flex flex-col items-center gap-2 px-5 py-3 rounded-full bg-background/70 backdrop-blur-md border border-primary/30 shadow-lg shadow-primary/15 hover:bg-background/80 hover:border-primary/50 transition-all duration-300 animate-bounce-slow"
    >
      <span className="text-xs text-foreground uppercase tracking-[0.2em] font-semibold">
        {isNearBottom ? "Top" : "Scroll"}
      </span>
      {isNearBottom ? (
        <ChevronUp className="w-7 h-7 text-primary" />
      ) : (
        <ChevronDown className="w-7 h-7 text-primary" />
      )}
    </button>
  );
};

export default ScrollIndicator;
