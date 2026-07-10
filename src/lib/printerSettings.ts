// Shared thermal printer settings, persisted in localStorage so the print
// popup can execute directly without prompting for size/DPI/printer/language
// every time. Configured once in Settings → Connect Printer.

export type ThermalLabelSizeId = "2x1" | "2.25x1.25" | "3x1" | "3.5x2";
export type Dpi = 203 | 300;
export type PrinterLanguage = "auto" | "zpl" | "gdi";

export interface ThermalPrinterSettings {
  sizeId: ThermalLabelSizeId;
  dpi: Dpi;
  printerName: string; // "" = auto-detect
  printerLanguage: PrinterLanguage;
}

export const THERMAL_LABEL_SIZES: { id: ThermalLabelSizeId; name: string; width: number; height: number }[] = [
  { id: "2x1", name: '2" × 1"', width: 2, height: 1 },
  { id: "2.25x1.25", name: '2.25" × 1.25"', width: 2.25, height: 1.25 },
  { id: "3x1", name: '3" × 1"', width: 3, height: 1 },
  { id: "3.5x2", name: '3.5" × 2"', width: 3.5, height: 2 },
];

const STORAGE_KEY = "thermalPrinterSettings.v1";

export const DEFAULT_THERMAL_SETTINGS: ThermalPrinterSettings = {
  sizeId: "2x1",
  dpi: 203,
  printerName: "",
  printerLanguage: "auto",
};

export const loadThermalSettings = (): ThermalPrinterSettings => {
  if (typeof window === "undefined") return DEFAULT_THERMAL_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_THERMAL_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<ThermalPrinterSettings>;
    return {
      sizeId: (parsed.sizeId as ThermalLabelSizeId) || DEFAULT_THERMAL_SETTINGS.sizeId,
      dpi: (parsed.dpi as Dpi) || DEFAULT_THERMAL_SETTINGS.dpi,
      printerName: typeof parsed.printerName === "string" ? parsed.printerName : "",
      printerLanguage: (parsed.printerLanguage as PrinterLanguage) || DEFAULT_THERMAL_SETTINGS.printerLanguage,
    };
  } catch {
    return DEFAULT_THERMAL_SETTINGS;
  }
};

export const saveThermalSettings = (settings: ThermalPrinterSettings) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // ignore quota / privacy mode failures
  }
};
