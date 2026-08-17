/**
 * Friendly category names → the `websiteDisplayGroupName` values SP-API really
 * returns.
 *
 * WHY THIS MAP EXISTS. Amazon has two different category vocabularies. The one
 * shoppers see ("Movies & TV", "Toys & Games", "Clothing, Shoes & Jewelry") is
 * the BROWSE NODE taxonomy. The one Catalog Items returns in
 * summaries[].websiteDisplayGroupName is internal, coarser, and often singular
 * or abbreviated.
 *
 * They are not the same strings. Checked against 30 distinct values observed
 * live in this account on 2026-08-17: of 29 standard department names, only
 * THREE matched exactly — Music, Video Games and Musical Instruments. Built
 * from the browse-node labels alone, 26 of 29 toggles would have matched
 * nothing and silently done nothing.
 *
 * `observed: true` means the value was seen in real data here. The rest are
 * inferred from Amazon's documented display groups and are shown with their
 * live count so an inferred-wrong mapping reads as "0 listings — no effect"
 * rather than quietly failing.
 *
 * Values are lowercased because matching is trim + lowercase everywhere —
 * source-qualification.ts, the preview RPC, and the stored rows all agree.
 */
export interface DisplayGroupCategory {
  label: string;
  /** Real websiteDisplayGroupName values, lowercased. */
  values: string[];
  /** Seen in this account's live data, rather than inferred from docs. */
  observed?: boolean;
}

export const CATEGORY_MAP: DisplayGroupCategory[] = [
  // --- media: the default-OFF set -------------------------------------------
  { label: "Books", values: ["book"], observed: true },
  // No "Movies & TV" string exists in this vocabulary at all.
  { label: "Movies & TV", values: ["dvd", "video", "video dvd", "blu-ray"], observed: true },
  // "Music" and "CDs & Vinyl" are one department here, so they are ONE toggle.
  // Two switches driving the same API value would contradict each other.
  { label: "Music & Vinyl", values: ["music", "digital music"], observed: true },
  { label: "Magazines", values: ["magazine"] },
  { label: "Kindle Store", values: ["digital text"] },

  // --- everything else ------------------------------------------------------
  { label: "Video Games", values: ["video games"], observed: true },
  { label: "Electronics", values: ["ce", "speakers", "photography", "lighting"], observed: true },
  { label: "Computers", values: ["personal computer"], observed: true },
  { label: "Cell Phones & Accessories", values: ["wireless"] },
  { label: "Toys & Games", values: ["toy"], observed: true },
  { label: "Baby", values: ["baby product"] },
  { label: "Sports & Outdoors", values: ["sports"], observed: true },
  { label: "Home & Kitchen", values: ["home", "kitchen"], observed: true },
  { label: "Furniture", values: ["furniture"] },
  { label: "Appliances", values: ["major appliances"] },
  { label: "Tools & Home Improvement", values: ["home improvement"], observed: true },
  { label: "Automotive", values: ["automotive parts and accessories"], observed: true },
  // BISS = Business, Industrial & Scientific Supplies.
  { label: "Industrial & Scientific", values: ["biss", "biss basic"], observed: true },
  { label: "Health & Household", values: ["health and beauty"], observed: true },
  { label: "Beauty & Personal Care", values: ["beauty"], observed: true },
  { label: "Grocery & Gourmet Food", values: ["grocery"], observed: true },
  { label: "Pet Supplies", values: ["pet products"], observed: true },
  { label: "Office Products", values: ["office product"], observed: true },
  { label: "Clothing, Shoes & Jewelry", values: ["apparel", "shoes", "jewelry"], observed: true },
  { label: "Luggage", values: ["luggage"], observed: true },
  { label: "Arts, Crafts & Sewing", values: ["art and craft supply"], observed: true },
  { label: "Musical Instruments", values: ["musical instruments"], observed: true },
  { label: "Patio, Lawn & Garden", values: ["lawn & patio"], observed: true },
  { label: "Software", values: ["software"] },
  { label: "Collectibles & Fine Art", values: ["collectible", "art", "entertainment collectibles"] },
  // Amazon's own catch-all. Real, and common enough to need a switch --
  // 9 listings carried it in the sample.
  { label: "Uncategorised (Amazon misc)", values: ["single detail page misc"], observed: true },
];

/** Every API value the map can reach, for spotting ones it cannot. */
export const MAPPED_VALUES: ReadonlySet<string> = new Set(CATEGORY_MAP.flatMap((c) => c.values));
