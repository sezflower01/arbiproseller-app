import { useEffect, useState } from "react";
import { enqueueRoi } from "./roiQueue";

/**
 * Live ROI hook — calls the same `calculate-roi` edge function used by
 * Created Listings / RoiCalculator / AssignmentsTable.
 *
 * Returns the SAME numbers the user sees when fetching a listing by ASIN:
 *  - live Amazon price (Buy Box / lowest new — from SP-API)
 *  - REAL Amazon fees (referral + FBA + closing) from SP-API GetMyFeesEstimate
 *  - net profit = amazonPrice − cost − totalFees
 *  - roi = profit / cost × 100
 *
 * If `cost` or `asin` is missing, or the SP-API call fails / fees are
 * unavailable, returns `roi: null` and `error: 'unavailable'` so the UI
 * can show "ROI unavailable" instead of pretending a number is accurate.
 */
export interface AmazonPresence {
  isAmazonOnListing: boolean;
  isAmazonBuyBoxWinner: boolean;
  amazonOfferCount: number;
  totalOfferCount: number;
  nonAmazonOfferCount: number;
  isAmazonDominant: boolean;
}

export interface LiveRoiResult {
  loading: boolean;
  error: string | null;
  amazonPrice: number | null;
  priceSource: string | null;
  totalFees: number | null;
  referralFee: number | null;
  fbaFee: number | null;
  variableClosingFee: number | null;
  otherFees: number | null;
  cost: number | null;
  profit: number | null;
  roi: number | null;
  margin: number | null;
  title: string | null;
  imageUrl: string | null;
  link: string | null;
  amazonPresence: AmazonPresence | null;
}

const EMPTY: LiveRoiResult = {
  loading: false,
  error: null,
  amazonPrice: null,
  priceSource: null,
  totalFees: null,
  referralFee: null,
  fbaFee: null,
  variableClosingFee: null,
  otherFees: null,
  cost: null,
  profit: null,
  roi: null,
  margin: null,
  title: null,
  imageUrl: null,
  link: null,
  amazonPresence: null,
};

export function useLiveRoi(
  asin: string | null,
  cost: number | null,
  marketplace: string = "US",
): LiveRoiResult {
  const [state, setState] = useState<LiveRoiResult>(EMPTY);

  useEffect(() => {
    let cancelled = false;
    if (!asin || cost == null || !(cost > 0)) {
      setState(EMPTY);
      return;
    }

    setState((s) => ({ ...EMPTY, loading: true, cost }));

    (async () => {
      try {
        const data = await enqueueRoi(asin, cost, marketplace);

        if (cancelled) return;

        const calc = data?.calculation;
        if (!calc || data?.price == null || data?.price <= 0) {
          console.warn("[useLiveRoi] no usable price/calc", { asin, price: data?.price, hasCalc: !!calc });
          setState({
            ...EMPTY,
            cost,
            amazonPrice: data?.price ?? null,
            priceSource: data?.priceSource ?? null,
            title: data?.title ?? null,
            imageUrl: data?.imageUrl ?? null,
            link: data?.link ?? null,
            error: "unavailable",
          });
          return;
        }

        const num = (v: unknown): number | null => {
          if (v == null) return null;
          const n = Number(v);
          return Number.isFinite(n) ? n : null;
        };

        setState({
          loading: false,
          error: null,
          cost,
          amazonPrice: num(data.price),
          priceSource: data.priceSource ?? null,
          totalFees: num(calc.totalFees),
          referralFee: num(calc.referralFee),
          fbaFee: num(calc.fbaFee),
          variableClosingFee: num(calc.variableClosingFee),
          otherFees: num(calc.otherFees),
          profit: num(calc.profit),
          roi: num(calc.roi),
          margin: num(calc.margin),
          title: data.title ?? null,
          imageUrl: data.imageUrl ?? null,
          link: data.link ?? null,
          amazonPresence: (data.amazonPresence ?? null) as AmazonPresence | null,
        });
      } catch (e) {
        if (cancelled) return;
        console.warn("[useLiveRoi] exception", { asin, error: e });
        setState({
          ...EMPTY,
          cost,
          error: e instanceof Error ? e.message : "unavailable",
        });
      }
    })();

    return () => { cancelled = true; };
  }, [asin, cost, marketplace]);

  return state;
}
