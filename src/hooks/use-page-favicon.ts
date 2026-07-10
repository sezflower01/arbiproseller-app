import { useEffect } from "react";

/**
 * Dynamically sets the browser tab favicon to a colored letter on a rounded square.
 * Call once per page component.
 */
export function usePageFavicon(letter: string, bgColor = "#0266a3", textColor = "#ffffff") {
  useEffect(() => {
    const size = 64;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Rounded rectangle background
    const r = 12;
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(size - r, 0);
    ctx.quadraticCurveTo(size, 0, size, r);
    ctx.lineTo(size, size - r);
    ctx.quadraticCurveTo(size, size, size - r, size);
    ctx.lineTo(r, size);
    ctx.quadraticCurveTo(0, size, 0, size - r);
    ctx.lineTo(0, r);
    ctx.quadraticCurveTo(0, 0, r, 0);
    ctx.closePath();
    ctx.fillStyle = bgColor;
    ctx.fill();

    // Letter
    ctx.fillStyle = textColor;
    ctx.font = "bold 44px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(letter, size / 2, size / 2 + 2);

    const url = canvas.toDataURL("image/png");

    // Collect all favicon-related links and store originals
    const selectors = [
      "link[rel='icon']",
      "link[rel='shortcut icon']",
      "link[rel='apple-touch-icon']",
    ];
    const originals: { el: HTMLLinkElement; href: string }[] = [];

    selectors.forEach((sel) => {
      const el = document.querySelector(sel) as HTMLLinkElement | null;
      if (el) {
        originals.push({ el, href: el.href });
        el.href = url;
      }
    });

    // If none existed, create one
    if (originals.length === 0) {
      const link = document.createElement("link");
      link.rel = "icon";
      link.href = url;
      document.head.appendChild(link);
      originals.push({ el: link, href: "" });
    }

    // Restore originals on unmount
    return () => {
      originals.forEach(({ el, href }) => {
        if (href) {
          el.href = href;
        } else {
          el.remove();
        }
      });
    };
  }, [letter, bgColor, textColor]);
}
