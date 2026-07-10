import Barcode from "react-barcode";

export type LabelSizeId = "a4-40up" | "2x1" | "2.25x1.25" | "3x1" | "3.5x2";

interface ProductLabelProps {
  asin: string;
  fnsku?: string | null;
  condition?: string | null;
  title: string;
  sizeId?: LabelSizeId;
}

// Physical dimensions per single label (CSS units).
// Thermal sizes keep the barcode high and place the one-line condition/title directly under the barcode text.
const sizeToDims: Record<LabelSizeId, { w: string; h: string; barcodeHeight: number; barcodeWidth: number; fontSize: number; titleSize: string; titleHeight: string }> = {
  // A4 large label layout. Frame sized to fit the barcode tightly and centered on the page.
  "a4-40up":     { w: "200mm", h: "55mm",   barcodeHeight: 140, barcodeWidth: 3.6, fontSize: 22, titleSize: "14px", titleHeight: "13mm" },
  // Thermal: barcode prints first, condition/title sits close underneath it.
  "2x1":         { w: "2in",    h: "1in",    barcodeHeight: 30, barcodeWidth: 1.5,  fontSize: 17, titleSize: "8px",  titleHeight: "0.30in" },
  "2.25x1.25":   { w: "2.25in", h: "1.25in", barcodeHeight: 42, barcodeWidth: 1.7,  fontSize: 18, titleSize: "9px",  titleHeight: "0.34in" },
  "3x1":         { w: "3in",    h: "1in",    barcodeHeight: 30, barcodeWidth: 2.0,  fontSize: 18, titleSize: "9px",  titleHeight: "0.30in" },
  "3.5x2":       { w: "3.5in",  h: "2in",    barcodeHeight: 76, barcodeWidth: 2.4,  fontSize: 20, titleSize: "11px", titleHeight: "0.42in" },
};

export const ProductLabel = ({
  asin,
  fnsku,
  condition,
  title,
  sizeId = "a4-40up",
}: ProductLabelProps) => {
  const barcodeValue = (fnsku || "").trim().toUpperCase();
  const hasPrintableFnsku = /^X[A-Z0-9]{9}$/.test(barcodeValue) && barcodeValue !== asin.trim().toUpperCase();
  const displayCondition = (condition || "NEW").toUpperCase().includes("NEW") ? "New" : (condition || "NEW").toUpperCase();
  const titleWithCondition = `${displayCondition} - ${title}`;

  const dims = sizeToDims[sizeId];

  return (
    <div
      className="product-label bg-white text-black"
      style={{
        width: dims.w,
        height: dims.h,
        padding: 0,
        margin: sizeId === "a4-40up" ? "0 auto" : 0,
        boxSizing: "border-box",
        position: "relative",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "flex-start",
        overflow: "hidden",
        fontFamily: "Arial, Helvetica, sans-serif",
        gap: 0,
      }}
    >
      {/* Barcode at top, natural size — no flex stretch so no gap forms below it. */}
      <div
        className="barcode-wrap"
        style={{
          flex: "0 0 auto",
          margin: 0,
          padding: 0,
          lineHeight: 0,
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "center",
          width: "100%",
          overflow: "hidden",
          transform: sizeId === "a4-40up" ? undefined : "scaleX(0.88)",
          transformOrigin: "top center",
        }}
      >
        {hasPrintableFnsku ? (
          <Barcode
            value={barcodeValue}
            width={dims.barcodeWidth}
            height={dims.barcodeHeight}
            fontSize={dims.fontSize}
            fontOptions="bold"
            margin={0}
            displayValue={sizeId !== "a4-40up"}
            background="transparent"
            lineColor="#000000"
          />
        ) : (
          <div style={{ fontSize: 12, fontWeight: 800, lineHeight: 1.2, paddingTop: 10, color: "#b91c1c" }}>
            FNSKU REQUIRED
          </div>
        )}
      </div>

      {/* Title sits immediately under the barcode value — no fixed height, no gap. */}
      <div
        className="w-full"
        style={{
          flex: "0 0 auto",
          textAlign: "center",
          padding: sizeId === "a4-40up" ? 0 : "0 4px",
          marginTop: sizeId === "a4-40up" ? 0 : -2,
          overflow: "visible",
          boxSizing: "border-box",
          color: "#000000",
          lineHeight: 1.1,
        }}
      >
        <p
          style={{
            display: "block",
            fontSize: dims.titleSize,
            fontFamily: "Arial, Helvetica, sans-serif",
            fontWeight: 700,
            margin: 0,
            padding: "1px 0 4px",
            width: "100%",
            overflow: "hidden",
            whiteSpace: "nowrap",
            textOverflow: "ellipsis",
            lineHeight: 1.4,
            color: "#000000",
          }}
        >
          <span style={{ fontWeight: 800 }}>{displayCondition}</span>
          {` - ${title}`}
        </p>

      </div>
    </div>
  );
};
