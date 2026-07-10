// Amazon business day = midnight-to-midnight Pacific Time.
// All order_date values in the DB are stored in PT, so UI must query with PT boundaries.
export const SALES_BUSINESS_TZ = 'America/Los_Angeles';

export function getBusinessDateISO(date: Date = new Date(), timeZone: string = SALES_BUSINESS_TZ): string {
  return date.toLocaleDateString('en-CA', { timeZone });
}

export function addDaysISO(dateStr: string, delta: number): string {
  const d = new Date(`${dateStr}T12:00:00`);
  d.setDate(d.getDate() + delta);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

export function makePeriodKey(params: {
  marketplaceKey: string;
  startDate: string;
  endDate: string;
}): string {
  return `${params.marketplaceKey}|${params.startDate}|${params.endDate}`;
}
