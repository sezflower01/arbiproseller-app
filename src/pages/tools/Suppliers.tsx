import { useState, useEffect, useMemo } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { Loader2, ChevronDown, ChevronRight, ExternalLink, Package, Search, ArrowUpDown } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import Navbar from '@/components/Navbar';
import { calculateReplenishQty } from '@/lib/replenishment';
import { getListingTotalCost, getListingUnitCost } from '@/lib/cost-contract';

type Supplier = {
  domain: string;
  count: number;
  products: Product[];
};

type Product = {
  id: string;
  asin: string;
  title: string | null;
  image_url: string | null;
  supplier_links: any;
  amazon_price: number | null;
  cost: number | null;
  units: number | null;
  amount: number | null;
  date_created: string | null;
  available: number;
  inbound: number;
  salesUnits: number;
  replenishQty: number;
  historicalSales?: number;
  historicalDays?: number;
};

export default function Suppliers() {
  const { user } = useAuth();
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [expandedSupplier, setExpandedSupplier] = useState<string | null>(null);
  const [expandedAsin, setExpandedAsin] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [asinSearch, setAsinSearch] = useState('');
  const [supplierSearch, setSupplierSearch] = useState('');
  const [dateSortOrder, setDateSortOrder] = useState<'asc' | 'desc'>('desc');
  const [sortBy, setSortBy] = useState<'date' | 'replenish'>('date');
  const now = new Date();
  const [selectedMonth, setSelectedMonth] = useState<string>(String(now.getMonth())); // 0-indexed
  const [selectedYear, setSelectedYear] = useState<string>(String(now.getFullYear()));

  // Get available years from data
  const availableYears = useMemo(() => {
    const years = new Set<number>();
    suppliers.forEach(s => s.products.forEach(p => {
      if (p.date_created) years.add(new Date(p.date_created).getFullYear());
    }));
    if (years.size === 0) years.add(now.getFullYear());
    return Array.from(years).sort((a, b) => b - a);
  }, [suppliers]);

  const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // Filter and sort suppliers based on ASIN search, month/year, and sort option
  const filteredSuppliers = useMemo(() => {
    let result = suppliers;

    // Filter by supplier domain
    if (supplierSearch.trim()) {
      const term = supplierSearch.trim().toLowerCase();
      result = result.filter(s => s.domain.toLowerCase().includes(term));
    }

    // Filter by month/year
    const filterMonth = parseInt(selectedMonth);
    const filterYear = parseInt(selectedYear);
    result = result.map(supplier => {
      const filtered = supplier.products.filter(p => {
        if (!p.date_created) return false;
        const d = new Date(p.date_created);
        return d.getMonth() === filterMonth && d.getFullYear() === filterYear;
      });
      return { ...supplier, products: filtered, count: filtered.length };
    }).filter(s => s.products.length > 0);
    
    if (asinSearch.trim()) {
      const searchTerm = asinSearch.trim().toUpperCase();
      result = result
        .map(supplier => ({
          ...supplier,
          products: supplier.products.filter(p => 
            p.asin.toUpperCase().includes(searchTerm)
          ),
        }))
        .filter(supplier => supplier.products.length > 0)
        .map(supplier => ({
          ...supplier,
          count: supplier.products.length,
        }));
    }
    
    // Sort products within each supplier
    return result.map(supplier => ({
      ...supplier,
      products: [...supplier.products].sort((a, b) => {
        if (sortBy === 'replenish') {
          return b.replenishQty - a.replenishQty;
        }
        if (!a.date_created && !b.date_created) return 0;
        if (!a.date_created) return dateSortOrder === 'asc' ? -1 : 1;
        if (!b.date_created) return dateSortOrder === 'asc' ? 1 : -1;
        const dateA = new Date(a.date_created).getTime();
        const dateB = new Date(b.date_created).getTime();
        return dateSortOrder === 'asc' ? dateA - dateB : dateB - dateA;
      }),
    }));
  }, [suppliers, asinSearch, supplierSearch, dateSortOrder, sortBy, selectedMonth, selectedYear]);

  // Auto-expand when supplier search narrows to one result
  useEffect(() => {
    if (supplierSearch.trim() && filteredSuppliers.length === 1) {
      setExpandedSupplier(filteredSuppliers[0].domain);
    }
  }, [filteredSuppliers, supplierSearch]);

  // Count how many times each ASIN appears across all suppliers
  const asinCounts = useMemo(() => {
    const counts = new Map<string, number>();
    suppliers.forEach(supplier => {
      supplier.products.forEach(product => {
        counts.set(product.asin, (counts.get(product.asin) || 0) + 1);
      });
    });
    return counts;
  }, [suppliers]);

  // Get all products for a specific ASIN across all suppliers
  const getProductsByAsin = (asin: string) => {
    const products: (Product & { supplierDomain: string })[] = [];
    suppliers.forEach(supplier => {
      supplier.products.forEach(product => {
        if (product.asin === asin) {
          products.push({ ...product, supplierDomain: supplier.domain });
        }
      });
    });
    return products.sort((a, b) => {
      if (!a.date_created || !b.date_created) return 0;
      return new Date(b.date_created).getTime() - new Date(a.date_created).getTime();
    });
  };

  useEffect(() => {
    if (user) {
      loadSuppliers();
    }
  }, [user]);

  const loadSuppliers = async () => {
    if (!user) return;

    try {
      setLoading(true);

      // Fetch created_listings for image, title, cost, units, supplier_links
      const { data: listingsData, error: listingsError } = await supabase
        .from('created_listings')
        .select('*')
        .eq('user_id', user.id)
        .order('date_created', { ascending: false });

      if (listingsError) throw listingsError;

      // Fetch inventory for Amazon prices, image, title, available, inbound
      const { data: inventoryData, error: inventoryError } = await supabase
        .from('inventory')
        .select('asin, price, image_url, title, available, inbound')
        .eq('user_id', user.id);

      if (inventoryError) throw inventoryError;

      // Fetch sales_orders for image/title fallback
      const { data: salesData, error: salesError } = await supabase
        .from('sales_orders')
        .select('asin, image_url, title, quantity, order_date')
        .eq('user_id', user.id);

      if (salesError) throw salesError;

      // Calculate sales periods - use actual days with sales data for accurate ADS
      const today = new Date();
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().split('T')[0];

      // Create a map of ASIN to 30-day sales with actual period tracking
      const salesMap = new Map<string, { units: number; earliestOrderDate: string }>();
      // Also create a map of ASIN to sales image/title for fallback
      const salesImageMap = new Map<string, { image_url: string | null; title: string | null }>();
      // Create a map of ASIN to historical sales (all-time) with earliest date
      const historicalSalesMap = new Map<string, { totalUnits: number; earliestDate: string }>();
      
      salesData?.forEach((sale) => {
        // Count 30-day sales with period tracking
        if (sale.order_date >= thirtyDaysAgoStr) {
          const existing = salesMap.get(sale.asin);
          if (existing) {
            existing.units += (sale.quantity || 1);
            if (sale.order_date < existing.earliestOrderDate) {
              existing.earliestOrderDate = sale.order_date;
            }
          } else {
            salesMap.set(sale.asin, {
              units: sale.quantity || 1,
              earliestOrderDate: sale.order_date
            });
          }
        }
        // Count all-time historical sales
        const current = historicalSalesMap.get(sale.asin);
        if (current) {
          current.totalUnits += (sale.quantity || 1);
          if (sale.order_date < current.earliestDate) {
            current.earliestDate = sale.order_date;
          }
        } else {
          historicalSalesMap.set(sale.asin, {
            totalUnits: sale.quantity || 1,
            earliestDate: sale.order_date,
          });
        }
        // Store image/title from sales (use first valid one found)
        if (!salesImageMap.has(sale.asin) && (sale.image_url || sale.title)) {
          salesImageMap.set(sale.asin, {
            image_url: sale.image_url,
            title: sale.title
          });
        }
      });

      // Helper to calculate days since a date
      const getDaysSince = (dateStr: string): number => {
        const date = new Date(dateStr);
        const diffMs = today.getTime() - date.getTime();
        return Math.max(1, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
      };

      // Create a map of ASIN to inventory data
      const inventoryMap = new Map<string, { 
        price: number | null; 
        image_url: string | null; 
        title: string | null;
        available: number;
        inbound: number;
      }>();
      inventoryData?.forEach((inv) => {
        inventoryMap.set(inv.asin, {
          price: inv.price,
          image_url: inv.image_url,
          title: inv.title,
          available: inv.available || 0,
          inbound: inv.inbound || 0
        });
      });

      // Group products by supplier domain
      const supplierMap = new Map<string, Product[]>();

      listingsData?.forEach((item) => {
        const supplierLinks = Array.isArray(item.supplier_links) ? item.supplier_links : [];
        
        supplierLinks.forEach((linkObj: any) => {
          try {
            // Handle both string links and object links with {link, discount_code}
            const linkUrl = typeof linkObj === 'string' ? linkObj : linkObj?.link;
            if (!linkUrl) return;
            
            // Remove leading # if present
            const cleanUrl = linkUrl.startsWith('#') ? linkUrl.substring(1) : linkUrl;
            
            const url = new URL(cleanUrl);
            const domain = url.hostname.replace('www.', '');
            
            if (!supplierMap.has(domain)) {
              supplierMap.set(domain, []);
            }
            
            // Get data from inventory table (price, image, title, available, inbound)
            const inventoryItem = inventoryMap.get(item.asin);
            const salesItem = salesImageMap.get(item.asin);
            const recentSalesData = salesMap.get(item.asin);
            const salesUnits = recentSalesData?.units || 0;
            // Calculate actual days in the 30-day period based on when first sale occurred
            const salesPeriodDays = recentSalesData 
              ? Math.min(30, getDaysSince(recentSalesData.earliestOrderDate))
              : 30;
            
            // Use inventory data first, then created_listings, then sales_orders as fallback
            const amazonPrice = inventoryItem?.price ?? null;
            const imageUrl = inventoryItem?.image_url || item.image_url || salesItem?.image_url || null;
            const title = (inventoryItem?.title && inventoryItem.title !== 'Untitled Product') 
              ? inventoryItem.title 
              : (item.title && item.title !== 'Untitled Product') 
                ? item.title 
                : (salesItem?.title && salesItem.title !== 'UNKNOWN')
                  ? salesItem.title
                  : null;
            
            const available = inventoryItem?.available || 0;
            const inbound = inventoryItem?.inbound || 0;
            
            // Get historical sales data for fallback
            const historicalData = historicalSalesMap.get(item.asin);
            const historicalSales = historicalData?.totalUnits || 0;
            const historicalDays = historicalData ? getDaysSince(historicalData.earliestDate) : undefined;
            
            // Calculate replenishment quantity using actual sales period
            const replenishQty = calculateReplenishQty({
              salesUnits,
              salesPeriodDays, // Use actual period instead of fixed 30
              available,
              inbound,
              coverageDays: 30,
              safetyPercent: 0.1,
              historicalSalesUnits: historicalSales,
              historicalDays: historicalDays
            });
            
            supplierMap.get(domain)?.push({
              id: item.id,
              asin: item.asin,
              title: title,
              image_url: imageUrl,
              supplier_links: item.supplier_links,
              amazon_price: amazonPrice,
              cost: item.cost,
              units: item.units,
              amount: (item as any).amount ?? null,
              date_created: item.date_created,
              available,
              inbound,
              salesUnits,
              replenishQty,
              historicalSales,
              historicalDays
            });
          } catch (e) {
            // Skip invalid URLs
          }
        });
      });

      // Convert to array and sort by product count
      const suppliersArray: Supplier[] = Array.from(supplierMap.entries())
        .map(([domain, products]) => ({
          domain,
          count: products.length,
          products,
        }))
        .sort((a, b) => b.count - a.count);

      setSuppliers(suppliersArray);
    } catch (error: any) {
      console.error('Error loading suppliers:', error);
      toast.error('Failed to load suppliers');
    } finally {
      setLoading(false);
    }
  };

  const toggleSupplier = (domain: string) => {
    setExpandedSupplier(expandedSupplier === domain ? null : domain);
  };

  const getSupplierLinkForProduct = (product: Product, supplierDomain: string) => {
    const links = Array.isArray(product.supplier_links) ? product.supplier_links : [];
    const linkObj = links.find((linkObj: any) => {
      try {
        const linkUrl = typeof linkObj === 'string' ? linkObj : linkObj?.link;
        if (!linkUrl) return false;
        
        const cleanUrl = linkUrl.startsWith('#') ? linkUrl.substring(1) : linkUrl;
        const url = new URL(cleanUrl);
        return url.hostname.replace('www.', '') === supplierDomain;
      } catch {
        return false;
      }
    });
    
    // Return the actual link URL
    if (!linkObj) return null;
    const linkUrl = typeof linkObj === 'string' ? linkObj : linkObj?.link;
    return linkUrl?.startsWith('#') ? linkUrl.substring(1) : linkUrl;
  };

  if (loading) {
    return (
      <>
        <Navbar />
        <div className="container mx-auto py-8 pt-24 flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </>
    );
  }

  return (
    <>
      <Navbar />
      <div className="container mx-auto py-8 px-4 pt-24">
      <div className="mb-6">
        <h1 className="text-3xl font-bold mb-2">Suppliers</h1>
        <p className="text-muted-foreground">
          View all your suppliers and their purchased products
        </p>
      </div>

      {/* Search & Filter Controls */}
      <div className="mb-6 flex flex-col sm:flex-row gap-3 items-end flex-wrap">
        <div className="relative max-w-xs w-full">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by supplier..."
            value={supplierSearch}
            onChange={(e) => setSupplierSearch(e.target.value)}
            className="pl-10"
          />
        </div>
        <div className="relative max-w-xs w-full">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by ASIN..."
            value={asinSearch}
            onChange={(e) => setAsinSearch(e.target.value)}
            className="pl-10"
          />
        </div>
        <Select value={selectedMonth} onValueChange={setSelectedMonth}>
          <SelectTrigger className="w-[110px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MONTH_NAMES.map((name, idx) => (
              <SelectItem key={idx} value={String(idx)}>{name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={selectedYear} onValueChange={setSelectedYear}>
          <SelectTrigger className="w-[90px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {availableYears.map(y => (
              <SelectItem key={y} value={String(y)}>{y}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {(asinSearch || supplierSearch) && (
        <p className="text-sm text-muted-foreground mb-4">
          Showing {filteredSuppliers.reduce((acc, s) => acc + s.products.length, 0)} products across {filteredSuppliers.length} suppliers
        </p>
      )}

      {suppliers.length === 0 ? (
        <Card className="p-8 text-center">
          <Package className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
          <h3 className="text-lg font-semibold mb-2">No Suppliers Found</h3>
          <p className="text-muted-foreground mb-4">
            Suppliers are automatically extracted from products in your Created Listings.
            <br />
            Import products with supplier links to see them grouped here.
          </p>
          <Button asChild>
            <a href="/tools/created-listings">Go to Created Listings</a>
          </Button>
        </Card>
      ) : (
        <div className="space-y-4">
          {filteredSuppliers.map((supplier) => (
            <Card key={supplier.domain} className="overflow-hidden">
              <button
                onClick={() => toggleSupplier(supplier.domain)}
                className="w-full p-4 flex items-center justify-between hover:bg-accent transition-colors"
              >
                <div className="flex items-center gap-3">
                  {expandedSupplier === supplier.domain ? (
                    <ChevronDown className="h-5 w-5 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-5 w-5 text-muted-foreground" />
                  )}
                  <div className="text-left">
                    <h3 className="font-semibold text-lg">{supplier.domain}</h3>
                    <p className="text-sm text-muted-foreground">
                      {supplier.count} {supplier.count === 1 ? 'product' : 'products'}
                    </p>
                  </div>
                </div>
              </button>

              {expandedSupplier === supplier.domain && (
                <div className="border-t">
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead className="bg-muted/50">
                        <tr>
                          <th className="px-4 py-3 text-left text-sm font-medium">Image</th>
                          <th className="px-4 py-3 text-left text-sm font-medium">ASIN</th>
                          <th className="px-4 py-3 text-left text-sm font-medium">Title</th>
                          <th className="px-4 py-3 text-left text-sm font-medium">Amazon Price</th>
                          <th className="px-4 py-3 text-left text-sm font-medium">Cost</th>
                          <th className="px-4 py-3 text-left text-sm font-medium">Units</th>
                          <th className="px-4 py-3 text-left text-sm font-medium">Unit Cost</th>
                          <th 
                            className={`px-4 py-3 text-left text-sm font-medium cursor-pointer hover:bg-muted/70 transition-colors ${sortBy === 'replenish' ? 'bg-primary/10' : ''}`}
                            onClick={() => setSortBy('replenish')}
                          >
                            <div className="flex items-center gap-1">
                              Replenish
                              <ArrowUpDown className="h-3 w-3" />
                              {sortBy === 'replenish' && <span className="text-xs text-primary">↓</span>}
                            </div>
                          </th>
                          <th 
                            className={`px-4 py-3 text-left text-sm font-medium cursor-pointer hover:bg-muted/70 transition-colors ${sortBy === 'date' ? 'bg-primary/10' : ''}`}
                            onClick={() => {
                              if (sortBy === 'date') {
                                setDateSortOrder(dateSortOrder === 'asc' ? 'desc' : 'asc');
                              } else {
                                setSortBy('date');
                              }
                            }}
                          >
                            <div className="flex items-center gap-1">
                              Date
                              <ArrowUpDown className="h-3 w-3" />
                              {sortBy === 'date' && (
                                <span className="text-xs text-primary">
                                  {dateSortOrder === 'desc' ? '↓' : '↑'}
                                </span>
                              )}
                            </div>
                          </th>
                          <th className="px-4 py-3 text-left text-sm font-medium">Links</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {supplier.products.map((product) => {
                          const supplierLink = getSupplierLinkForProduct(product, supplier.domain);
                          return (
                            <tr key={product.id} className="hover:bg-muted/30">
                              <td className="px-4 py-3">
                                {product.image_url ? (
                                  <img
                                    src={product.image_url}
                                    alt={product.title || product.asin}
                                    className="w-12 h-12 object-contain"
                                  />
                                ) : (
                                  <div className="w-12 h-12 bg-muted rounded flex items-center justify-center">
                                    <Package className="h-6 w-6 text-muted-foreground" />
                                  </div>
                                )}
                              </td>
                              <td className="px-4 py-3">
                                <div className="flex flex-col gap-1">
                                  <div className="flex items-center gap-2">
                                    <a
                                      href={`https://www.amazon.com/dp/${product.asin}`}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="text-primary hover:underline flex items-center gap-1 font-mono text-sm"
                                    >
                                      {product.asin}
                                      <ExternalLink className="h-3 w-3" />
                                    </a>
                                    {asinCounts.get(product.asin)! > 1 && (
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setExpandedAsin(expandedAsin === product.asin ? null : product.asin);
                                        }}
                                        className="bg-amber-100 text-amber-800 text-xs font-medium px-2 py-0.5 rounded hover:bg-amber-200 cursor-pointer transition-colors"
                                      >
                                        ×{asinCounts.get(product.asin)} {expandedAsin === product.asin ? '▲' : '▼'}
                                      </button>
                                    )}
                                  </div>
                                  {expandedAsin === product.asin && (
                                    <div className="mt-2 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                                      <p className="text-xs font-semibold text-amber-800 mb-2">
                                        All {asinCounts.get(product.asin)} purchases of this ASIN:
                                      </p>
                                      <div className="space-y-2">
                                        {getProductsByAsin(product.asin).map((p, idx) => (
                                          <div key={p.id + '-' + idx} className="flex items-center justify-between text-xs bg-white p-2 rounded border">
                                            <div>
                                              <span className="font-medium">{p.supplierDomain}</span>
                                              {(() => {
                                                const u = getListingUnitCost({ cost: p.cost, units: p.units, amount: p.amount });
                                                return u !== null ? (
                                                  <span className="ml-2 text-muted-foreground">
                                                    ${u.toFixed(2)}/unit
                                                  </span>
                                                ) : null;
                                              })()}
                                            </div>
                                            <span className="text-muted-foreground">
                                              {p.date_created
                                                ? new Date(p.date_created).toLocaleDateString('en-US')
                                                : 'No date'}
                                            </span>
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                </div>
                              </td>
                              <td className="px-4 py-3 max-w-xs">
                                <p className="truncate text-sm">{product.title || '—'}</p>
                              </td>
                              <td className="px-4 py-3 text-sm">
                                {product.amazon_price ? `$${product.amazon_price.toFixed(2)}` : '—'}
                              </td>
                              <td className="px-4 py-3 text-sm">
                                {(() => {
                                  const t = getListingTotalCost(product);
                                  return t !== null ? `$${t.toFixed(2)}` : '—';
                                })()}
                              </td>
                              <td className="px-4 py-3 text-sm">{product.units || '—'}</td>
                              <td className="px-4 py-3 text-sm">
                                {(() => {
                                  const u = getListingUnitCost(product);
                                  return u !== null ? `$${u.toFixed(2)}` : '—';
                                })()}
                              </td>
                              <td className="px-4 py-3 text-sm">
                                {product.replenishQty > 0 ? (
                                  <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-amber-100 text-amber-800">
                                    {product.replenishQty}
                                  </span>
                                ) : (
                                  <span className="text-muted-foreground">—</span>
                                )}
                              </td>
                              <td className="px-4 py-3 text-sm">
                                {product.date_created
                                  ? new Date(product.date_created).toLocaleDateString('en-US')
                                  : '—'}
                              </td>
                              <td className="px-4 py-3">
                                {supplierLink && (
                                  <a
                                    href={supplierLink}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1 text-primary hover:underline text-sm"
                                  >
                                    View Source
                                    <ExternalLink className="h-3 w-3" />
                                  </a>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
      </div>
    </>
  );
}
