import html2canvas from "html2canvas";

/**
 * Rasterize a DOM node containing a <ProductLabel> into a PNG data URL.
 *
 * The node is expected to be sized in physical inches via inline CSS (the
 * <ProductLabel> component already does this). We pick a `scale` that turns
 * each CSS inch into the correct number of printer dots so the PNG matches the
 * label perfectly when sent to the print client.
 *
 * @param node    the DOM element to rasterize (must be in the document tree —
 *                position it off-screen, but do not set `display: none` or
 *                html2canvas will skip it)
 * @param widthIn label width in inches (e.g. 2 for a 2x1 label)
 * @param dpi     printer DPI (203 or 300)
 */
export async function renderLabelToPng(
  node: HTMLElement,
  widthIn: number,
  dpi: number
): Promise<string> {
  // CSS treats 1in as 96 CSS pixels. We need the canvas to expose `widthIn * dpi`
  // device pixels, so scale = (widthIn * dpi) / (widthIn * 96) = dpi / 96.
  const scale = dpi / 96;

  const canvas = await html2canvas(node, {
    backgroundColor: "#ffffff",
    scale,
    useCORS: true,
    logging: false,
    // Avoid html2canvas trying to inline cross-origin fonts, which would slow us down.
    allowTaint: false,
  });

  return canvas.toDataURL("image/png");
}
