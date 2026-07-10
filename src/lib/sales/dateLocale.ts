// Marketplace-aware date formatter for sales views.
//
// IMPORTANT: Postgres DATE columns arrive as "YYYY-MM-DD" strings.
// Per [DATE Column TZ Parsing] memory: NEVER pass them through `new Date(str)`
// directly — that parses as UTC midnight and can roll back a day in negative
// timezones. Split the parts manually and construct a local Date.

const MARKETPLACE_LOCALE: Record<string, string> = {
  US: "en-US",
  CA: "en-CA",
  MX: "es-MX",
  BR: "pt-BR",
  UK: "en-GB",
  GB: "en-GB",
  DE: "de-DE",
  FR: "fr-FR",
  IT: "it-IT",
  ES: "es-ES",
  NL: "nl-NL",
  SE: "sv-SE",
  PL: "pl-PL",
  TR: "tr-TR",
  JP: "ja-JP",
  AU: "en-AU",
  SG: "en-SG",
  IN: "en-IN",
  AE: "ar-AE",
  SA: "ar-SA",
  EG: "ar-EG",
};

export function localeForMarketplace(marketplace: string | null | undefined): string {
  if (!marketplace) return "en-US";
  return MARKETPLACE_LOCALE[marketplace.toUpperCase()] ?? "en-US";
}

/**
 * Format a "YYYY-MM-DD" string (or any Date input) using the seller's
 * home-marketplace conventions. US sellers see 06/06/2026; CA sellers see
 * 2026-06-06; UK sellers see 06/06/2026; MX sellers see 6/6/2026; etc.
 */
export function formatMarketplaceDate(
  value: string | Date | null | undefined,
  marketplace: string | null | undefined,
): string {
  if (!value) return "—";
  let d: Date;
  if (value instanceof Date) {
    d = value;
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, day] = value.split("-").map(Number);
    d = new Date(y, m - 1, day);
  } else {
    d = new Date(value);
  }
  if (Number.isNaN(d.getTime())) return String(value);
  try {
    return new Intl.DateTimeFormat(localeForMarketplace(marketplace), {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  } catch {
    return String(value);
  }
}
