/**
 * Resolves whether "Respect minimum ROI" is on for a specific marketplace.
 *
 * Historically min_roi_enabled was a single boolean covering every
 * marketplace at once. It's now overridable per marketplace via
 * min_roi_enabled_marketplace_overrides — a marketplace absent from that map
 * falls back to the legacy global boolean, so rules created before this
 * change keep behaving exactly as they did.
 */
export function resolveMinRoiEnabled(
  rule: { min_roi_enabled?: boolean | null; min_roi_enabled_marketplace_overrides?: Record<string, boolean> | null },
  marketplace: string,
): boolean {
  const overrides = rule.min_roi_enabled_marketplace_overrides;
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, marketplace)) {
    return !!overrides[marketplace];
  }
  return rule.min_roi_enabled ?? false;
}
