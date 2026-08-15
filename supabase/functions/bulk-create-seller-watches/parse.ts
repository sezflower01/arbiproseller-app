// Input parsing for bulk seller-watch uploads.
//
// Extracted into its own module rather than mirrored into a test file (the
// pattern check-price-alerts uses to work around Deno.serve at module scope).
// This logic decides which rows get written to a user's watchlist, so a test
// copy that silently drifts from the real implementation would be worse than
// no test at all.

/** Amazon seller IDs are uppercase alphanumeric. Matches create-seller-watch. */
export const SELLER_ID_RE = /^[A-Z0-9]{6,20}$/i;

/**
 * Pull a seller ID out of one input line.
 *
 * Accepts a bare ID, a full storefront URL (`?me=...`), or a delimited row
 * where the ID sits in any column -- people paste exports that carry a name
 * or note alongside the ID, and rejecting those would be needless friction.
 * Returns null when nothing in the line looks like a seller ID.
 */
export function parseSellerLine(rawLine: string): string | null {
  const line = rawLine.trim();
  if (!line) return null;

  // A storefront URL anywhere in the line wins -- it is unambiguous, and its
  // `me` parameter is the seller ID by definition. Checked first because such
  // a URL also contains other long alphanumeric runs (marketplaceID, ref
  // tags) that the column scan below could otherwise mistake for the ID.
  const me = line.match(/[?&]me=([A-Z0-9]+)/i);
  if (me) return me[1].toUpperCase();

  const fields = line
    .split(/[,;\t]/)
    .map((f) => f.trim().replace(/^["']|["']$/g, ''));

  for (const field of fields) {
    if (SELLER_ID_RE.test(field)) return field.toUpperCase();
  }
  return null;
}

/**
 * Split pasted text or CSV contents into candidate lines.
 *
 * Drops a leading header row -- but only when it genuinely looks like one:
 * nothing in it parses as a seller ID while the following line does. A file
 * whose very first line is a real ID keeps that ID.
 */
export function splitInputLines(text: string): string[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return lines;

  if (parseSellerLine(lines[0]) === null && parseSellerLine(lines[1]) !== null) {
    return lines.slice(1);
  }
  return lines;
}

export interface ClassifiedInput {
  /** Unique, valid seller IDs in first-seen order. */
  parsed: string[];
  /** Lines that contained nothing resembling a seller ID (truncated). */
  invalid: string[];
  /** IDs that appeared more than once in this upload. */
  duplicates: string[];
}

/** Parse every line, dedupe, and bucket the rejects for the preview summary. */
export function classifyInput(text: string, sampleCap = 50): ClassifiedInput {
  const lines = splitInputLines(text);
  const seen = new Set<string>();
  const parsed: string[] = [];
  const invalid: string[] = [];
  const duplicates: string[] = [];

  for (const line of lines) {
    const sellerId = parseSellerLine(line);
    if (!sellerId) {
      if (invalid.length < sampleCap) invalid.push(line.slice(0, 120));
      continue;
    }
    if (seen.has(sellerId)) {
      if (duplicates.length < sampleCap) duplicates.push(sellerId);
      continue;
    }
    seen.add(sellerId);
    parsed.push(sellerId);
  }

  return { parsed, invalid, duplicates };
}
