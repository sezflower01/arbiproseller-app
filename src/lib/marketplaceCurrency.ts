// Marketplace currency configuration for multi-marketplace repricing
// All repricing math uses native currency; USD shown as secondary reference

export interface MarketplaceConfig {
  id: string;
  name: string;
  flag: string;
  currency: string;
  currencySymbol: string;
  marketplaceId: string;
  domain: string; // Amazon domain for product links
  // Suggested defaults for this market
  defaultUndercutStep: number;
  defaultCooldownMinutes: number;
  defaultMaxStepAmount: number;
}

export const MARKETPLACE_CONFIGS: Record<string, MarketplaceConfig> = {
  // North America
  US: {
    id: "US",
    name: "United States",
    flag: "🇺🇸",
    currency: "USD",
    currencySymbol: "$",
    marketplaceId: "ATVPDKIKX0DER",
    domain: "amazon.com",
    defaultUndercutStep: 0.01,
    defaultCooldownMinutes: 15,
    defaultMaxStepAmount: 0.50,
  },
  CA: {
    id: "CA",
    name: "Canada",
    flag: "🇨🇦",
    currency: "CAD",
    currencySymbol: "C$",
    marketplaceId: "A2EUQ1WTGCTBG2",
    domain: "amazon.ca",
    defaultUndercutStep: 0.01,
    defaultCooldownMinutes: 30,
    defaultMaxStepAmount: 0.50,
  },
  MX: {
    id: "MX",
    name: "Mexico",
    flag: "🇲🇽",
    currency: "MXN",
    currencySymbol: "MX$",
    marketplaceId: "A1AM78C64UM0Y8",
    domain: "amazon.com.mx",
    defaultUndercutStep: 1.00,
    defaultCooldownMinutes: 30,
    defaultMaxStepAmount: 10.00,
  },
  BR: {
    id: "BR",
    name: "Brazil",
    flag: "🇧🇷",
    currency: "BRL",
    currencySymbol: "R$",
    marketplaceId: "A2Q3Y263D00KWC",
    domain: "amazon.com.br",
    defaultUndercutStep: 0.05,
    defaultCooldownMinutes: 30,
    defaultMaxStepAmount: 2.50,
  },
  // Europe
  UK: {
    id: "UK",
    name: "United Kingdom",
    flag: "🇬🇧",
    currency: "GBP",
    currencySymbol: "£",
    marketplaceId: "A1F83G8C2ARO7P",
    domain: "amazon.co.uk",
    defaultUndercutStep: 0.01,
    defaultCooldownMinutes: 30,
    defaultMaxStepAmount: 0.50,
  },
  DE: {
    id: "DE",
    name: "Germany",
    flag: "🇩🇪",
    currency: "EUR",
    currencySymbol: "€",
    marketplaceId: "A1PA6795UKMFR9",
    domain: "amazon.de",
    defaultUndercutStep: 0.01,
    defaultCooldownMinutes: 30,
    defaultMaxStepAmount: 0.50,
  },
  ES: {
    id: "ES",
    name: "Spain",
    flag: "🇪🇸",
    currency: "EUR",
    currencySymbol: "€",
    marketplaceId: "A1RKKUPIHCS9HS",
    domain: "amazon.es",
    defaultUndercutStep: 0.01,
    defaultCooldownMinutes: 30,
    defaultMaxStepAmount: 0.50,
  },
  FR: {
    id: "FR",
    name: "France",
    flag: "🇫🇷",
    currency: "EUR",
    currencySymbol: "€",
    marketplaceId: "A13V1IB3VIYZZH",
    domain: "amazon.fr",
    defaultUndercutStep: 0.01,
    defaultCooldownMinutes: 30,
    defaultMaxStepAmount: 0.50,
  },
  IT: {
    id: "IT",
    name: "Italy",
    flag: "🇮🇹",
    currency: "EUR",
    currencySymbol: "€",
    marketplaceId: "APJ6JRA9NG5V4",
    domain: "amazon.it",
    defaultUndercutStep: 0.01,
    defaultCooldownMinutes: 30,
    defaultMaxStepAmount: 0.50,
  },
  NL: {
    id: "NL",
    name: "Netherlands",
    flag: "🇳🇱",
    currency: "EUR",
    currencySymbol: "€",
    marketplaceId: "A1805IZSGTT6HS",
    domain: "amazon.nl",
    defaultUndercutStep: 0.01,
    defaultCooldownMinutes: 30,
    defaultMaxStepAmount: 0.50,
  },
  SE: {
    id: "SE",
    name: "Sweden",
    flag: "🇸🇪",
    currency: "SEK",
    currencySymbol: "kr",
    marketplaceId: "A2NODRKZP88ZB9",
    domain: "amazon.se",
    defaultUndercutStep: 0.10,
    defaultCooldownMinutes: 30,
    defaultMaxStepAmount: 5.00,
  },
  PL: {
    id: "PL",
    name: "Poland",
    flag: "🇵🇱",
    currency: "PLN",
    currencySymbol: "zł",
    marketplaceId: "A1C3SOZRARQ6R3",
    domain: "amazon.pl",
    defaultUndercutStep: 0.05,
    defaultCooldownMinutes: 30,
    defaultMaxStepAmount: 2.00,
  },
  BE: {
    id: "BE",
    name: "Belgium",
    flag: "🇧🇪",
    currency: "EUR",
    currencySymbol: "€",
    marketplaceId: "AMEN7PMS3EDWL",
    domain: "amazon.com.be",
    defaultUndercutStep: 0.01,
    defaultCooldownMinutes: 30,
    defaultMaxStepAmount: 0.50,
  },
  TR: {
    id: "TR",
    name: "Turkey",
    flag: "🇹🇷",
    currency: "TRY",
    currencySymbol: "₺",
    marketplaceId: "A33AVAJ2PDY3EV",
    domain: "amazon.com.tr",
    defaultUndercutStep: 0.50,
    defaultCooldownMinutes: 30,
    defaultMaxStepAmount: 20.00,
  },
};

export const MARKETPLACE_LIST = Object.values(MARKETPLACE_CONFIGS);

export function getMarketplaceConfig(marketplace: string): MarketplaceConfig {
  return MARKETPLACE_CONFIGS[marketplace] || MARKETPLACE_CONFIGS.US;
}

export function formatPrice(
  amount: number | null | undefined,
  marketplace: string,
  options?: { showSymbol?: boolean; decimals?: number }
): string {
  if (amount == null) return "—";
  
  const config = getMarketplaceConfig(marketplace);
  const { showSymbol = true, decimals = 2 } = options || {};
  
  const formatted = amount.toFixed(decimals);
  return showSymbol ? `${config.currencySymbol}${formatted}` : formatted;
}

export function formatPriceWithUsdEquivalent(
  amount: number | null | undefined,
  marketplace: string,
  fxRate: number | null | undefined
): { native: string; usd: string | null } {
  if (amount == null) {
    return { native: "—", usd: null };
  }
  
  const config = getMarketplaceConfig(marketplace);
  const native = `${config.currencySymbol}${amount.toFixed(2)}`;
  
  // For US, no need to show USD equivalent
  if (marketplace === "US" || !fxRate || fxRate === 0) {
    return { native, usd: null };
  }
  
  // Convert to USD: amount / fxRate (fxRate is USD -> local)
  const usdAmount = amount / fxRate;
  const usd = `$${usdAmount.toFixed(2)}`;
  
  return { native, usd };
}

export function getCurrencyForMarketplace(marketplace: string): string {
  return getMarketplaceConfig(marketplace).currency;
}

export function getMarketplaceIdFromCode(marketplace: string): string {
  return getMarketplaceConfig(marketplace).marketplaceId;
}

export function getMarketplaceFromId(marketplaceId: string): string {
  const found = MARKETPLACE_LIST.find(m => m.marketplaceId === marketplaceId);
  return found?.id || "US";
}

// Region groupings for API endpoint selection
export const NA_MARKETPLACES = ["US", "CA", "MX", "BR"];
export const EU_MARKETPLACES = ["UK", "DE", "FR", "IT", "ES", "NL", "SE", "PL", "BE", "TR"];

// Get the SP-API endpoint based on marketplace region
export function getSpApiEndpoint(marketplace: string): string {
  if (EU_MARKETPLACES.includes(marketplace)) {
    return "sellingpartnerapi-eu.amazon.com";
  }
  return "sellingpartnerapi-na.amazon.com";
}

// Get all marketplace IDs for eligibility checking
export function getAllMarketplaceIds(): { id: string; marketplaceId: string; name: string; flag: string }[] {
  return MARKETPLACE_LIST.map(m => ({
    id: m.id,
    marketplaceId: m.marketplaceId,
    name: m.name,
    flag: m.flag
  }));
}

/**
 * Convert an amount between currencies using USD-based cross-rates.
 * Formula: amount × (USD→to / USD→from)
 * 
 * For USD-based sellers (default), this collapses to the existing behavior.
 * For non-USD sellers, it correctly derives cross-rates.
 */
export async function convertCurrencyClient(
  amount: number,
  fromCurrency: string,
  toCurrency: string,
  supabase: any,
): Promise<{ converted: number; fxRate: number }> {
  if (fromCurrency === toCurrency) {
    return { converted: amount, fxRate: 1 };
  }
  
  // Fetch both USD→from and USD→to rates in parallel
  const [fromResult, toResult] = await Promise.all([
    fromCurrency === 'USD' ? Promise.resolve({ data: { rate: 1 } }) :
      supabase.from('fx_rates').select('rate').eq('base', 'USD').eq('quote', fromCurrency).single(),
    toCurrency === 'USD' ? Promise.resolve({ data: { rate: 1 } }) :
      supabase.from('fx_rates').select('rate').eq('base', 'USD').eq('quote', toCurrency).single(),
  ]);
  
  const usdToFrom = fromResult.data?.rate || 1;
  const usdToTo = toResult.data?.rate || 1;
  const fxRate = usdToTo / usdToFrom;
  
  return { converted: amount * fxRate, fxRate };
}
