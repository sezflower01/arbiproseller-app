// Single source of truth for marketplace metadata used across edge
// functions (Amazon marketplace ID <-> short region code, currency).
// Mirrors src/lib/marketplaceMeta.ts on the frontend side — keep both in
// sync when adding a new marketplace/region.
export interface MarketplaceMeta {
  code: string;
  amazonMarketplaceId: string;
  currency: string;
}

export const MARKETPLACE_META: Record<string, MarketplaceMeta> = {
  US: { code: "US", amazonMarketplaceId: "ATVPDKIKX0DER", currency: "USD" },
  CA: { code: "CA", amazonMarketplaceId: "A2EUQ1WTGCTBG2", currency: "CAD" },
  MX: { code: "MX", amazonMarketplaceId: "A1AM78C64UM0Y8", currency: "MXN" },
  BR: { code: "BR", amazonMarketplaceId: "A2Q3Y263D00KWC", currency: "BRL" },
  UK: { code: "UK", amazonMarketplaceId: "A1F83G8C2ARO7P", currency: "GBP" },
  DE: { code: "DE", amazonMarketplaceId: "A1PA6795UKMFR9", currency: "EUR" },
  FR: { code: "FR", amazonMarketplaceId: "A13V1IB3VIYZZH", currency: "EUR" },
  IT: { code: "IT", amazonMarketplaceId: "APJ6JRA9NG5V4", currency: "EUR" },
  ES: { code: "ES", amazonMarketplaceId: "A1RKKUPIHCS9HS", currency: "EUR" },
  NL: { code: "NL", amazonMarketplaceId: "A1805IZSGTT6HS", currency: "EUR" },
  SE: { code: "SE", amazonMarketplaceId: "A2NODRKZP88ZB9", currency: "SEK" },
  PL: { code: "PL", amazonMarketplaceId: "A1C3SOZRARQ6R3", currency: "PLN" },
  BE: { code: "BE", amazonMarketplaceId: "AMEN7PMS3EDWL", currency: "EUR" },
  TR: { code: "TR", amazonMarketplaceId: "A33AVAJ2PDY3EV", currency: "TRY" },
};

const AMAZON_ID_TO_CODE: Record<string, string> = Object.fromEntries(
  Object.values(MARKETPLACE_META).map((m) => [m.amazonMarketplaceId, m.code])
);

export function marketplaceIdToCode(amazonMarketplaceId: string): string | null {
  return AMAZON_ID_TO_CODE[amazonMarketplaceId] || null;
}

export function marketplaceCurrency(code: string): string {
  return MARKETPLACE_META[code]?.currency || "USD";
}
