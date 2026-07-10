export interface Product {
  id: string;
  sku: string;
  asin: string;
  fnsku?: string | null;
  title: string;
  image_url?: string | null;
  totalQtyToShip: number;
  expirationDate?: string | null;
  requiresExpirationDate?: boolean; // From Amazon prep details or manual override
  prepCategory?: string | null; // e.g., 'ADULT', 'BABY', 'FRAGILE', 'HANGER', 'LIQUID', 'NONE', etc.
}

export interface BoxItem {
  productId: string;
  sku: string;
  quantityInThisBox: number;
}

export interface Box {
  boxIndex: number;
  items: BoxItem[];
  weight?: number;
  weightUnit?: 'kg' | 'lb';
}

export interface BoxDimensions {
  length: number;
  width: number;
  height: number;
  dimensionUnit: 'cm' | 'in';
}

export interface BoxWeight {
  weight: number;
  weightUnit: 'kg' | 'lb';
}

export interface SellerAddress {
  businessName: string;
  name: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  stateOrProvinceCode: string;
  postalCode: string;
  countryCode: string;
  phone?: string;
  email?: string;
}

export interface ShipmentDraft {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  step: 'products' | 'quantities' | 'boxes' | 'address' | 'warehouse' | 'shipping' | 'labels';
  products: Product[];
  numberOfBoxes?: number;
  boxes?: Box[];
  boxDimensions?: BoxDimensions;
  useIdenticalWeights?: boolean;
  commonWeight?: BoxWeight;
  sellerAddress?: SellerAddress;
  inboundPlanId?: string;
  shipmentId?: string;
}

export interface TransportationOption {
  transportationOptionId: string;
  carrier: string;
  carrierCode?: string;
  shippingMode?: string;
  shippingSolution?: string;
  preconditions?: string[];
  quote?: {
    currency: string;
    amount: number;
    voidableUntil?: string;
  };
}

export interface PlacementShipment {
  shipmentId: string;
  destinationFcId: string;
  destinationFcName: string;
}

export interface PlacementFee {
  feeType: string;
  feeAmount: { currency: string; amount: number };
}

export interface PlacementDiscount {
  description: string;
  target: string;
  type: string;
  value: { amount: number; code: string };
}

export interface PlacementOption {
  placementOptionId: string;
  shipmentIds?: string[];
  shipments?: PlacementShipment[];
  fees?: PlacementFee[];
  discounts?: PlacementDiscount[];
  status?: string;
  totalFees?: number;
  totalDiscounts?: number;
  netCost?: number;
  isRecommended?: boolean;
}

export interface ShipmentJSON {
  shipmentId: string;
  shipmentName: string;
  numberOfBoxes: number;
  boxDimensions: BoxDimensions;
  destinationFulfillmentCenter?: string | null;
  sourceAddress: SellerAddress;
  boxes: Box[];
  products: Array<{
    sku: string;
    asin: string;
    fnsku?: string | null;
    title: string;
    quantity: number;
    expirationDate?: string | null;
  }>;
}
