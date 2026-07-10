/**
 * Generates a unique SKU in format like AA4-B59-3GEE
 * Format: XXX-XXX-XXXX where X can be letter or number
 */
export function generateSKU(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  
  const randomChar = () => chars.charAt(Math.floor(Math.random() * chars.length));
  
  const part1 = Array.from({ length: 3 }, randomChar).join('');
  const part2 = Array.from({ length: 3 }, randomChar).join('');
  const part3 = Array.from({ length: 4 }, randomChar).join('');
  
  return `${part1}-${part2}-${part3}`;
}
