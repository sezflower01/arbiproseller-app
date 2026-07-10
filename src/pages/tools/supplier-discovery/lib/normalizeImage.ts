/**
 * Some supplier images contain CDN size placeholders that the browser can't load directly.
 *
 * Currently handles:
 * - BigCommerce Stencil: replaces `{:size}` (or its URL-encoded form `%7B:size%7D`)
 *   with a sensible default like `500x500`.
 *
 * Safe to call on any URL — returns the input unchanged if no placeholder is present.
 */
export function normalizeSupplierImageUrl(url?: string | null, size = "500x500"): string | null {
  if (!url) return null;
  // Handle both raw and URL-encoded BigCommerce placeholders
  return url
    .replace(/\{:size\}/g, size)
    .replace(/%7B:size%7D/gi, size);
}
