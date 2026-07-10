import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Slider } from '@/components/ui/slider';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { ArrowLeft, Search, Filter, ExternalLink } from 'lucide-react';
import Navbar from '@/components/Navbar';

interface Category {
  id: string;
  name: string;
}

interface Retailer {
  id: string;
  name: string;
}

interface AsinItem {
  id: string;
  asin: string;
  amz_title: string;
  amz_price: number;
  amz_image: string;
  amz_link: string;
  category: string;
  g_title: string;
  g_price: number;
  g_image: string;
  g_link: string;
  g_store: string;
  roi: number;
  margin_pct: number;
  match_score: number;
  title_score: number;
  source: string;
  status: string;
}

const ProductSearch = () => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [retailers, setRetailers] = useState<Retailer[]>([]);
  const [selectedRetailer, setSelectedRetailer] = useState<string>('all');
  const [categories, setCategories] = useState<Category[]>([]);
  const [allCategories, setAllCategories] = useState<Category[]>([]);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [results, setResults] = useState<AsinItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [minRoi, setMinRoi] = useState(0);
  const [currentBatchId, setCurrentBatchId] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [displayMinRoi, setDisplayMinRoi] = useState(0);
  const [displayMinMatchScore, setDisplayMinMatchScore] = useState(0);

  useEffect(() => {
    loadRetailers();
    loadCategories();
  }, []);

  useEffect(() => {
    filterCategoriesByRetailer();
  }, [selectedRetailer, allCategories]);

  const loadRetailers = async () => {
    const { data, error } = await supabase
      .from('retailers')
      .select('*')
      .order('name');

    if (error) {
      toast({
        title: 'Error loading retailers',
        description: error.message,
        variant: 'destructive',
      });
      return;
    }

    setRetailers(data || []);
  };

  const loadCategories = async () => {
    const { data, error } = await supabase
      .from('categories')
      .select('*')
      .order('name');

    if (error) {
      toast({
        title: 'Error loading categories',
        description: error.message,
        variant: 'destructive',
      });
      return;
    }

    // Filter out subcategories (those with underscores)
    const mainCategories = (data || []).filter(cat => !cat.name.includes('_'));
    setAllCategories(mainCategories);
    setCategories(mainCategories);
  };

  const filterCategoriesByRetailer = async () => {
    if (selectedRetailer === 'all') {
      setCategories(allCategories);
      return;
    }

    // Get categories for selected retailer from asin_items
    const { data, error } = await supabase
      .from('asin_items')
      .select('category')
      .eq('g_store', selectedRetailer)
      .not('category', 'is', null);

    if (error) {
      toast({
        title: 'Error filtering categories',
        description: error.message,
        variant: 'destructive',
      });
      return;
    }

    // Get unique categories
    const uniqueCategories = [...new Set(data.map(item => item.category))];
    
    // Filter allCategories to only those in uniqueCategories
    const filteredCategories = allCategories.filter(cat => 
      uniqueCategories.includes(cat.name)
    );
    
    setCategories(filteredCategories);
    // Clear selected categories that are no longer available
    setSelectedCategories(prev => 
      prev.filter(cat => uniqueCategories.includes(cat))
    );
  };

  const searchByCategory = async () => {
    if (selectedCategories.length === 0) {
      toast({
        title: 'Select categories',
        description: 'Please select at least one category to search',
        variant: 'destructive',
      });
      return;
    }

    setLoading(true);

    try {
      // Get all asin_items for selected categories
      let query = supabase
        .from('asin_items')
        .select('*', { count: 'exact' })
        .in('category', selectedCategories)
        .eq('status', 'done')
        .not('roi', 'is', null);

      // Apply retailer filter
      if (selectedRetailer !== 'all') {
        query = query.eq('g_store', selectedRetailer);
      }

      // Apply ROI filter
      if (minRoi > 0) {
        query = query.gte('roi', minRoi);
      }

      const { data, error, count } = await query.order('roi', { ascending: false }).limit(10000);

      if (error) throw error;

      setResults(data || []);
      
      toast({
        title: 'Search complete',
        description: `Found ${data?.length || 0} products${count && count > (data?.length || 0) ? ` (showing first ${data?.length})` : ''}`,
      });
    } catch (error: any) {
      toast({
        title: 'Search failed',
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  // Get filtered results for display
  const getFilteredResults = () => {
    return results.filter(item => {
      // Filter by display ROI
      if (displayMinRoi > 0 && item.roi < displayMinRoi) return false;
      
      // Filter by match score
      if (displayMinMatchScore > 0 && (item.match_score ?? 0) < displayMinMatchScore) return false;
      
      // Filter by category filter
      if (categoryFilter !== 'all' && item.category !== categoryFilter) return false;
      
      // Exclude amazon.com retailers
      if (item.g_store?.toLowerCase().includes('amazon.com')) return false;
      
      return true;
    });
  };

  const handleStartScan = async () => {
    if (selectedCategories.length === 0) {
      toast({
        title: 'Select categories',
        description: 'Please select at least one category to scan',
        variant: 'destructive',
      });
      return;
    }

    setScanning(true);

    try {
      // Get all ASINs that have selected categories from asin_items
      const { data: categoryAsins, error: asinError } = await supabase
        .from('asin_items')
        .select('asin')
        .in('category', selectedCategories)
        .order('asin');

      if (asinError) throw asinError;

      if (!categoryAsins || categoryAsins.length === 0) {
        toast({
          title: 'No ASINs found',
          description: 'No ASINs found for this category.',
          variant: 'destructive',
        });
        setScanning(false);
        return;
      }

      // Get unique ASINs
      const uniqueAsins = [...new Set(categoryAsins.map(item => item.asin))];

      console.log('ASINs to scan for category:', uniqueAsins.length);

      // Get current user
      const { data: { user } } = await supabase.auth.getUser();

      // Create a new batch
      const { data: newBatch, error: batchError } = await supabase
        .from('asin_batches')
        .insert({
          user_id: user?.id,
          filename: `${selectedCategories.join(', ')} Scan - ${new Date().toLocaleString()}`,
          total: uniqueAsins.length,
          processed: 0,
          status: 'queued'
        })
        .select()
        .single();

      if (batchError) throw batchError;

      console.log('Created batch:', newBatch.id);
      setCurrentBatchId(newBatch.id);

      // Insert all ASINs into the new batch
      const itemsToInsert = uniqueAsins.map((asin, idx) => ({
        batch_id: newBatch.id,
        asin,
        idx,
        status: 'queued'
      }));

      const { error: insertError } = await supabase
        .from('asin_items')
        .insert(itemsToInsert);

      if (insertError) throw insertError;

      // Update batch total
      await supabase
        .from('asin_batches')
        .update({ total: uniqueAsins.length })
        .eq('id', newBatch.id);

      toast({
        title: 'Scan started',
        description: `Processing ${uniqueAsins.length} ASINs across ${selectedCategories.length} categories`
      });

      // Start processing the batch
      const processChunk = async () => {
        try {
          const { data, error } = await supabase.functions.invoke('admin-process-asin-batch', {
            body: {
              batch_id: newBatch.id,
              page_size: 10,
              useGoogle: true,
              useShopping: true,
            },
          });

          if (error) throw error;

          if (data?.canceled) {
            setScanning(false);
            return;
          }

          if (data.remaining > 0) {
            setTimeout(processChunk, 1000);
          } else {
            setScanning(false);
            toast({
              title: 'Scan complete',
              description: 'Category scan finished. Search again to see updated results.'
            });
            // Auto refresh results
            searchByCategory();
          }
        } catch (error: any) {
          console.error('Processing error:', error);
          toast({
            title: 'Processing error',
            description: error.message,
            variant: 'destructive',
          });
          setScanning(false);
        }
      };

      await processChunk();

    } catch (error: any) {
      toast({
        title: 'Scan failed',
        description: error.message,
        variant: 'destructive',
      });
      setScanning(false);
    }
  };

  const filteredResults = results.filter(item => item.roi >= minRoi);

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-50 to-white">
      <Navbar />
      
      <div className="container mx-auto px-4 py-24">
        <div className="mb-8">
          <Button
            variant="ghost"
            onClick={() => navigate('/tools')}
            className="mb-4"
          >
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Tools
          </Button>
          
          <h1 className="text-4xl font-bold text-gray-900 mb-2">
            Search Products by Category
          </h1>
          <p className="text-gray-600">
            Browse profitable products from our catalog by category
          </p>
        </div>

        {/* Search Controls */}
        <Card className="p-6 mb-8">
          <div className="space-y-6">
            {/* Retailer Filter */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Filter by Retailer
              </label>
              <Select value={selectedRetailer} onValueChange={setSelectedRetailer}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="All Retailers" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Retailers</SelectItem>
                  {retailers.map((retailer) => (
                    <SelectItem key={retailer.id} value={retailer.name}>
                      {retailer.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Category Selection */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="block text-sm font-medium text-gray-700">
                  Select Categories ({selectedCategories.length}/20 selected)
                  {selectedRetailer !== 'all' && (
                    <span className="ml-2 text-xs text-gray-500">
                      (filtered by {selectedRetailer})
                    </span>
                  )}
                </label>
                {selectedCategories.length > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSelectedCategories([])}
                    disabled={scanning}
                  >
                    Clear All
                  </Button>
                )}
              </div>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                {categories.map((category) => {
                  const isSelected = selectedCategories.includes(category.name);
                  return (
                    <Button
                      key={category.id}
                      variant={isSelected ? 'default' : 'outline'}
                      onClick={() => {
                        if (isSelected) {
                          setSelectedCategories(prev => prev.filter(c => c !== category.name));
                        } else if (selectedCategories.length < 20) {
                          setSelectedCategories(prev => [...prev, category.name]);
                        } else {
                          toast({
                            title: 'Limit reached',
                            description: 'You can select up to 20 categories at a time',
                            variant: 'destructive',
                          });
                        }
                      }}
                      className={`justify-start transition-all ${
                        isSelected ? 'font-medium shadow-sm' : ''
                      }`}
                      disabled={scanning}
                    >
                      {category.name}
                    </Button>
                  );
                })}
              </div>
              {categories.length === 0 && (
                <p className="text-sm text-gray-500 mt-2">
                  No categories available yet. Categories will appear once products are scanned.
                </p>
              )}
            </div>

            {scanning && (
              <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
                <div className="flex items-center gap-2 text-blue-700">
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-700"></div>
                  <span className="font-medium">Scanning in progress...</span>
                </div>
                <p className="text-sm text-blue-600 mt-2">
                  Processing ASINs for {selectedCategories.join(', ')}. This may take a few minutes.
                </p>
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                <Filter className="inline mr-2 h-4 w-4" />
                Minimum ROI: {minRoi}%
              </label>
              <Slider
                value={[minRoi]}
                onValueChange={(values) => setMinRoi(values[0])}
                min={0}
                max={200}
                step={5}
                className="w-full"
                disabled={scanning}
              />
              <div className="flex justify-between text-xs text-gray-500 mt-1">
                <span>0%</span>
                <span>200%</span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Button
                onClick={searchByCategory}
                disabled={selectedCategories.length === 0 || loading || scanning}
                className="w-full"
                size="lg"
                variant="outline"
              >
                <Search className="mr-2 h-4 w-4" />
                {loading ? 'Searching...' : 'Search Products'}
              </Button>

              <Button
                onClick={handleStartScan}
                disabled={selectedCategories.length === 0 || scanning || loading}
                className="w-full"
                size="lg"
              >
                {scanning ? 'Scanning...' : 'Start Scan'}
              </Button>
            </div>
          </div>
        </Card>

        {/* Results */}
        {results.length > 0 && (
          <Card className="p-6">
            <div className="mb-6 space-y-4">
              <div className="flex flex-wrap gap-4 items-end">
                <div className="flex-1 min-w-[200px]">
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Category Filter
                  </label>
                  <Select value={categoryFilter} onValueChange={setCategoryFilter}>
                    <SelectTrigger className="mt-2">
                      <SelectValue placeholder="All Categories" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Categories</SelectItem>
                      {[...new Set(results.map(item => item.category).filter(Boolean))].sort().map((cat) => (
                        <SelectItem key={cat} value={cat}>
                          {cat}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex-1 min-w-[200px]">
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Display ROI Filter: {displayMinRoi}%
                  </label>
                  <Slider
                    value={[displayMinRoi]}
                    onValueChange={(values) => setDisplayMinRoi(values[0])}
                    min={0}
                    max={100}
                    step={5}
                    className="w-full"
                  />
                </div>

                <div className="flex-1 min-w-[200px]">
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Match Score Filter: {displayMinMatchScore}%
                  </label>
                  <Slider
                    value={[displayMinMatchScore]}
                    onValueChange={(values) => setDisplayMinMatchScore(values[0])}
                    min={0}
                    max={100}
                    step={5}
                    className="w-full"
                  />
                </div>
              </div>

              <div className="flex justify-between items-center pt-2 border-t">
                <h2 className="text-xl font-semibold">
                  Results: {getFilteredResults().length} products
                </h2>
                <div className="flex flex-wrap gap-2">
                  {selectedCategories.map((cat) => (
                    <Badge key={cat} variant="secondary">
                      {cat}
                    </Badge>
                  ))}
                </div>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="p-2 text-left font-semibold">#</th>
                    <th className="p-2 text-left font-semibold">ASIN</th>
                    <th className="p-2 text-left font-semibold">Category</th>
                    <th className="p-2 text-left font-semibold">Amazon Title</th>
                    <th className="p-2 text-right font-semibold">Amazon Price</th>
                    <th className="p-2 text-left font-semibold">Retailer</th>
                    <th className="p-2 text-left font-semibold">Retailer Title</th>
                    <th className="p-2 text-right font-semibold">Retailer Price</th>
                    <th className="p-2 text-center font-semibold">Retailer URL</th>
                    <th className="p-2 text-right font-semibold">Match Score</th>
                    <th className="p-2 text-right font-semibold">ROI %</th>
                    <th className="p-2 text-right font-semibold">Margin %</th>
                    <th className="p-2 text-center font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {getFilteredResults().map((item, index) => (
                    <tr key={item.id} className="border-b hover:bg-accent/50">
                      <td className="p-2">{index + 1}</td>
                      <td className="p-2">
                        <a
                          href={`https://www.amazon.com/dp/${item.asin}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-mono text-xs text-primary hover:underline"
                        >
                          {item.asin}
                        </a>
                      </td>
                      <td className="p-2">
                        <span className="text-xs bg-muted px-2 py-1 rounded">
                          {item.category || 'N/A'}
                        </span>
                      </td>
                      <td className="p-2">
                        <div className="flex items-center space-x-2 max-w-[250px]">
                          {item.amz_image && (
                            <img src={item.amz_image} alt="" className="w-10 h-10 object-cover rounded flex-shrink-0" />
                          )}
                          <p className="text-xs truncate">{item.amz_title || '-'}</p>
                        </div>
                      </td>
                      <td className="p-2 text-right font-medium">
                        {item.amz_price ? `$${item.amz_price.toFixed(2)}` : '-'}
                      </td>
                      <td className="p-2">
                        <p className="text-xs font-medium">{item.g_store || '-'}</p>
                      </td>
                      <td className="p-2">
                        <div className="flex items-center space-x-2 max-w-[250px]">
                          {item.g_image && (
                            <img src={item.g_image} alt="" className="w-10 h-10 object-cover rounded flex-shrink-0" />
                          )}
                          {item.g_link ? (
                            <a
                              href={item.g_link}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-blue-600 dark:text-blue-400 hover:underline hover:text-blue-800 dark:hover:text-blue-300 font-medium truncate cursor-pointer"
                              title={item.g_title}
                            >
                              {item.g_title}
                            </a>
                          ) : (
                            <p className="text-xs truncate">{item.g_title || '-'}</p>
                          )}
                        </div>
                      </td>
                      <td className="p-2 text-right font-medium">
                        {item.g_price ? `$${item.g_price.toFixed(2)}` : '-'}
                      </td>
                      <td className="p-2 text-center">
                        {item.g_link ? (
                          <a
                            href={item.g_link}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center justify-center text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300"
                            title="Visit retailer"
                          >
                            <ExternalLink className="h-4 w-4" />
                          </a>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </td>
                      <td className="p-2 text-right font-medium">{item.match_score ?? '-'}</td>
                      <td className="p-2 text-right">
                        <span className={`font-semibold ${
                          item.roi && item.roi > 20 
                            ? 'text-green-600 dark:text-green-400' 
                            : item.roi && item.roi > 0
                            ? 'text-yellow-600 dark:text-yellow-400'
                            : 'text-red-600 dark:text-red-400'
                        }`}>
                          {item.roi ? `${item.roi.toFixed(1)}%` : '-'}
                        </span>
                      </td>
                      <td className="p-2 text-right">
                        {item.margin_pct ? `${item.margin_pct.toFixed(1)}%` : '-'}
                      </td>
                      <td className="p-2 text-center">
                        <span
                          className={`text-xs px-2 py-1 rounded ${
                            item.status === 'done'
                              ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
                              : item.status === 'error'
                              ? 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'
                              : 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200'
                          }`}
                        >
                          {item.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        {results.length === 0 && !loading && selectedCategories.length > 0 && (
          <Card className="p-12 text-center">
            <p className="text-gray-500">
              No results found for this category with the current filters.
            </p>
          </Card>
        )}
      </div>
    </div>
  );
};

export default ProductSearch;
