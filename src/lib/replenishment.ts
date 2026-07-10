// Replenishment forecast calculation for inventory management
// Based on sales velocity, available/inbound stock, lead-time pipeline, and safety buffer
// Supports historical ADS fallback for arbitrage products with irregular availability

export type ReplenishmentInput = {
  salesUnits: number;     // units sold in the given period
  salesPeriodDays: number; // the period in days for the sales data
  available: number;      // current FBA available units
  inbound: number;        // FBA inbound units (optional, can be 0)
  reserved?: number;      // FBA reserved units (optional, can be 0)
  coverageDays?: number;  // selling days to cover AFTER stock arrives (default 30)
  safetyPercent?: number; // safety stock as fraction (0.1 = 10%)
  // Lead-time pipeline (all in days, default 0 = old behavior)
  supplierLeadTimeDays?: number;   // days to receive from supplier
  prepDays?: number;               // days to prep/label before shipping
  shippingToAmazonDays?: number;   // transit days to Amazon FC
  amazonReceivingDays?: number;    // days until Amazon checks-in inventory
  // Historical fallback for products with no recent sales
  historicalSalesUnits?: number;
  historicalDays?: number;
};

export type ReplenishmentBreakdown = {
  ads: number;
  totalLeadTimeDays: number;
  planningDays: number;
  forecastDemand: number;
  safetyStock: number;
  totalPipelineStock: number;
  daysUntilStockout: number | null;
  replenishQty: number;
  riskLevel: 'critical' | 'high' | 'medium' | 'low' | 'unknown';
  riskLabel: string;
};

export function computeReplenishmentBreakdown(input: ReplenishmentInput): ReplenishmentBreakdown {
  const {
    salesUnits,
    salesPeriodDays,
    available,
    inbound,
    reserved = 0,
    coverageDays = 30,
    safetyPercent = 0.1,
    supplierLeadTimeDays = 0,
    prepDays = 0,
    shippingToAmazonDays = 0,
    amazonReceivingDays = 0,
    historicalSalesUnits,
    historicalDays,
  } = input;

  // 1. Average Daily Sales
  let ads = 0;
  if (salesUnits > 0 && salesPeriodDays > 0) {
    ads = salesUnits / salesPeriodDays;
  } else if (
    historicalSalesUnits && historicalSalesUnits > 0 &&
    historicalDays && historicalDays > 0
  ) {
    ads = historicalSalesUnits / historicalDays;
  }

  // 2. Lead-time pipeline
  const totalLeadTimeDays =
    (supplierLeadTimeDays || 0) +
    (prepDays || 0) +
    (shippingToAmazonDays || 0) +
    (amazonReceivingDays || 0);

  // 3. Planning horizon = lead time + desired post-arrival coverage
  const planningDays = (coverageDays || 0) + totalLeadTimeDays;

  // 4. Pipeline stock = anything we already have or that is on its way
  const totalPipelineStock = (available || 0) + (inbound || 0) + (reserved || 0);

  // 5. Forecast demand & safety
  const forecastDemand = ads * planningDays;
  const safetyStock = forecastDemand * safetyPercent;

  // 6. Recommended buy
  let replenishQty = 0;
  if (ads > 0) {
    const raw = (forecastDemand + safetyStock) - totalPipelineStock;
    replenishQty = raw <= 0 ? 0 : Math.round(raw);
  }

  // 7. Days until stockout (based on current pipeline + ADS)
  const daysUntilStockout = ads > 0 ? totalPipelineStock / ads : null;

  // 8. Risk classification
  let riskLevel: ReplenishmentBreakdown['riskLevel'] = 'unknown';
  let riskLabel = 'Unknown';
  if (ads > 0 && daysUntilStockout !== null) {
    if (daysUntilStockout <= totalLeadTimeDays) {
      riskLevel = 'critical';
      riskLabel = 'Critical — Buy Now';
    } else if (daysUntilStockout <= totalLeadTimeDays + 7) {
      riskLevel = 'high';
      riskLabel = 'High';
    } else if (daysUntilStockout <= totalLeadTimeDays + 14) {
      riskLevel = 'medium';
      riskLabel = 'Medium';
    } else {
      riskLevel = 'low';
      riskLabel = 'Low';
    }
  }

  return {
    ads,
    totalLeadTimeDays,
    planningDays,
    forecastDemand,
    safetyStock,
    totalPipelineStock,
    daysUntilStockout,
    replenishQty,
    riskLevel,
    riskLabel,
  };
}

// Backwards-compatible thin wrapper used by existing callers
export function calculateReplenishQty(input: ReplenishmentInput): number {
  return computeReplenishmentBreakdown(input).replenishQty;
}

// Calculate days of stock remaining based on current velocity
export function calculateDaysOfStock(
  salesUnits: number,
  salesPeriodDays: number,
  available: number,
  inbound: number,
  reserved: number = 0,
  historicalSalesUnits?: number,
  historicalDays?: number
): number | null {
  let ads = 0;

  if (salesUnits > 0 && salesPeriodDays > 0) {
    ads = salesUnits / salesPeriodDays;
  } else if (historicalSalesUnits && historicalSalesUnits > 0 && historicalDays && historicalDays > 0) {
    ads = historicalSalesUnits / historicalDays;
  }

  if (ads <= 0) return null;

  const totalInventory = (available || 0) + (inbound || 0) + (reserved || 0);
  return Math.round(totalInventory / ads);
}
