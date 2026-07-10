/**
 * Shared FX conversion utilities for edge functions.
 * 
 * All FX rates in the `fx_rates` table are stored as USD → X.
 * This module derives cross-rates for any seller home currency:
 *   rate(home → target) = rate(USD → target) / rate(USD → home)
 * 
 * For USD-based sellers, this collapses to the existing behavior (divisor = 1).
 */

// Fetch a single USD → target rate from Supabase
export async function getUsdToRate(supabase: any, targetCurrency: string): Promise<number> {
  if (targetCurrency === 'USD') return 1;

  const { data } = await supabase
    .from('fx_rates')
    .select('rate')
    .eq('base', 'USD')
    .eq('quote', targetCurrency)
    .single();

  if (data?.rate) return data.rate;

  // Fallbacks (last-resort only)
  const fallbacks: Record<string, number> = {
    CAD: 1.36, MXN: 17.5, BRL: 5.0, GBP: 0.79, EUR: 0.92,
  };
  return fallbacks[targetCurrency] || 1;
}

/**
 * Convert an amount from one currency to another using USD-based cross-rates.
 * 
 * Formula: amount × (USD→to / USD→from)
 * 
 * Examples:
 *   convertCurrency(10, 'USD', 'CAD', sb) → 10 × 1.36 / 1 = 13.60
 *   convertCurrency(10, 'CAD', 'USD', sb) → 10 × 1 / 1.36 = 7.35
 *   convertCurrency(10, 'CAD', 'MXN', sb) → 10 × 17.5 / 1.36 = 128.68
 *   convertCurrency(10, 'USD', 'USD', sb) → 10 (no-op)
 */
export async function convertCurrency(
  amount: number,
  fromCurrency: string,
  toCurrency: string,
  supabase: any,
): Promise<{ converted: number; fxRate: number }> {
  if (fromCurrency === toCurrency) {
    return { converted: amount, fxRate: 1 };
  }

  const [usdToFrom, usdToTo] = await Promise.all([
    getUsdToRate(supabase, fromCurrency),
    getUsdToRate(supabase, toCurrency),
  ]);

  // Cross-rate: home → target = (USD→target) / (USD→home)
  const fxRate = usdToTo / usdToFrom;
  return { converted: amount * fxRate, fxRate };
}

/**
 * Fetch the seller's home_currency from repricer_settings.
 * Defaults to 'USD' if not found (backward-compatible).
 */
export async function getSellerHomeCurrency(supabase: any, userId: string): Promise<string> {
  const { data } = await supabase
    .from('repricer_settings')
    .select('home_currency')
    .eq('user_id', userId)
    .single();

  return data?.home_currency || 'USD';
}
