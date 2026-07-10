import { useState, useEffect, useRef } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Slider } from '@/components/ui/slider';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { Upload, Play, Download, Loader2, Trash2, Pause, ExternalLink } from 'lucide-react';
import { Navigate } from 'react-router-dom';
import Navbar from '@/components/Navbar';

export default function AdminAsinUpload() {
  const { user } = useAuth();
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [batches, setBatches] = useState<any[]>([]);
  const [selectedBatch, setSelectedBatch] = useState<string | null>(null);
  const [items, setItems] = useState<any[]>([]);
  const [useShopping, setUseShopping] = useState(true);
  const [useGoogle, setUseGoogle] = useState(true);
  const [pageSize, setPageSize] = useState(100);
  const [minRoi, setMinRoi] = useState([0]);
  const [minScore, setMinScore] = useState([0]);
  const [showResults, setShowResults] = useState(false);
  const [displayMinRoi, setDisplayMinRoi] = useState([0]);
  const [displayMinMatchScore, setDisplayMinMatchScore] = useState([0]);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [availableCategories, setAvailableCategories] = useState<string[]>([]);
  const [scanLimit, setScanLimit] = useState(1000);
  const [manualAsins, setManualAsins] = useState('');
  const [manualProcessing, setManualProcessing] = useState(false);

  // Helper function for delays
  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  useEffect(() => {
    checkAdminStatus();
  }, [user]);

  useEffect(() => {
    if (isAdmin) {
      fetchBatches();
    }
  }, [isAdmin]);

  useEffect(() => {
    if (selectedBatch) {
      fetchItems(selectedBatch);
    }
  }, [selectedBatch, minRoi, minScore]);

  // Live progress polling - always poll when batch is selected
  useEffect(() => {
    if (!selectedBatch) return;
    
      const interval = setInterval(async () => {
        await fetchBatches();
        // Fetch the selected batch fresh to avoid stale closure state
        const { data: currentBatch } = await supabase
          .from('asin_batches')
          .select('*')
          .eq('id', selectedBatch)
          .single();

        if (currentBatch?.status === 'running') {
          setProcessing(true);
          await fetchItems(selectedBatch);
        } else if (currentBatch?.status === 'done') {
          setProcessing(false);
        }
      }, 2000);
    
    return () => clearInterval(interval);
  }, [selectedBatch]);

  const checkAdminStatus = async () => {
    if (!user?.email) {
      setIsAdmin(false);
      return;
    }

    const { data, error } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', user.id)
      .eq('role', 'admin')
      .single();

    setIsAdmin(!!data && !error);
  };

  const fetchBatches = async () => {
    const { data, error } = await supabase
      .from('asin_batches')
      .select('*')
      .order('created_at', { ascending: false });

    if (!error && data) {
      setBatches(data);
    }
  };

  const fetchItems = async (batchId: string) => {
    let query = supabase
      .from('asin_items')
      .select('*')
      .eq('batch_id', batchId)
      .order('idx');

    if (minScore[0] > 0) {
      query = query.gte('match_score', minScore[0]);
    }

    if (minRoi[0] > 0) {
      query = query.gte('roi', minRoi[0]);
    }

    const { data, error } = await query;

    if (!error && data) {
      setItems(data);
      
      // Extract unique categories from the items (filter out subcategories with underscores)
      const categories = [...new Set(data.map(item => item.category).filter(cat => cat && !cat.includes('_')))].sort();
      setAvailableCategories(categories);
      
      // Save categories to database
      for (const category of categories) {
        try {
          await supabase
            .from('categories')
            .insert({ name: category })
            .select();
        } catch (e) {
          // Ignore errors - category might already exist due to UNIQUE constraint
          console.log(`Category '${category}' already exists or error saving:`, e);
        }
      }
      
      // Extract unique retailers from the items
      const retailers = [...new Set(data.map(item => item.g_store).filter(store => store))].sort();
      
      // Save retailers to database
      for (const retailer of retailers) {
        try {
          await supabase
            .from('retailers')
            .insert({ name: retailer })
            .select();
        } catch (e) {
          // Ignore errors - retailer might already exist due to UNIQUE constraint
          console.log(`Retailer '${retailer}' already exists or error saving:`, e);
        }
      }
    }
  };

  // Filter items for display based on showResults filters
  const getDisplayItems = () => {
    if (!showResults) return [];
    
    return items.filter(item => {
      // Always include items marked as 'No results found'
      if (item.status === 'failed' && item.error === 'No results found') {
        return true;
      }
      
      // Include items that have Amazon data even if ROI isn't computed yet
      const hasAmazonData = !!(item.amz_title || item.amz_price || item.amz_image);
      if (!hasAmazonData) return false;
      
      // Apply ROI filter only when ROI exists
      if (displayMinRoi[0] > 0 && item.roi != null && item.roi < displayMinRoi[0]) return false;
      
      // Filter by match score threshold
      if (displayMinMatchScore[0] > 0 && (item.match_score ?? 0) < displayMinMatchScore[0]) return false;
      
      // Filter by categories (if any selected)
      if (selectedCategories.length > 0 && !selectedCategories.includes(item.category)) return false;
      
      // Exclude amazon.com retailers
      if (item.g_store && item.g_store.toLowerCase().includes('amazon.com')) return false;
      
      return true;
    });
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
    }
  };

  const handleUpload = async () => {
    if (!file) {
      toast({ title: 'Error', description: 'Please select a file', variant: 'destructive' });
      return;
    }

    setUploading(true);

    try {
      const formData = new FormData();
      formData.append('file', file);

      const { data, error } = await supabase.functions.invoke('admin-upload-asin-xlsx', {
        body: formData,
      });

      if (error) throw error;

      const skippedMsg = data.skipped_duplicates > 0 
        ? ` (${data.skipped_duplicates} duplicates skipped)` 
        : '';
      
      toast({
        title: "Upload successful",
        description: `Uploaded ${data.new_asins} new ASINs${skippedMsg}. Total in file: ${data.total_asins}`,
      });
      setFile(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      fetchBatches();
      setSelectedBatch(data.batch_id);
    } catch (error: any) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    } finally {
      setUploading(false);
    }
  };

  const handleProcess = async () => {
    if (!selectedBatch) return;

    const currentBatch = batches.find(b => b.id === selectedBatch);
    
    // If batch is already running, just show a message
    if (currentBatch?.status === 'running') {
      toast({ 
        title: 'Already processing', 
        description: 'This batch is already being processed in the background.',
      });
      return;
    }

    setProcessing(true);

    try {
      // Start the batch processing - it will continue server-side
      const { data, error } = await supabase.functions.invoke('admin-process-asin-batch', {
        body: {
          batch_id: selectedBatch,
          page_size: pageSize,
          useGoogle,
          useShopping,
        },
      });

      if (error) throw error;

      toast({ 
        title: 'Processing resumed', 
        description: 'Batch is processing in the background. You can leave this page and come back to check progress.',
      });

      await fetchBatches();
      await fetchItems(selectedBatch);
    } catch (error: any) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
      setProcessing(false);
    }
  };

  const handleScanFromStorage = async () => {
    setProcessing(true);

    try {
      // Fetch ASINs from asin_upload in chunks to bypass PostgREST 1k limit
      const target = scanLimit;
      const chunkSize = 1000;
      const fetchedAsins: string[] = [];

      for (let offset = 0; offset < target; offset += chunkSize) {
        const { data: chunk, error: asinError } = await supabase
          .from('asin_upload')
          .select('asin')
          .order('asin')
          .range(offset, Math.min(offset + chunkSize - 1, target - 1));

        if (asinError) {
          console.error('Error fetching ASINs chunk:', asinError);
          throw asinError;
        }

        if (!chunk || chunk.length === 0) break;
        fetchedAsins.push(...chunk.map((i) => i.asin));
      }

      console.log('Total ASIN records fetched from asin_upload:', fetchedAsins.length || 0);

      if (fetchedAsins.length === 0) {
        toast({ 
          title: 'No ASINs found', 
          description: 'No ASINs found in storage. Upload a batch first.',
          variant: 'destructive' 
        });
        setProcessing(false);
        return;
      }

      // Get already processed ASINs from all batches to avoid duplicates
      const { data: existingItems } = await supabase
        .from('asin_items')
        .select('asin');
      
      const existingAsins = new Set(existingItems?.map(item => item.asin) || []);
      
      // Filter out already processed ASINs
      const uniqueAsins = Array.from(new Set(fetchedAsins)).filter(asin => !existingAsins.has(asin));
      
      console.log(`Filtered ASINs: ${uniqueAsins.length} new out of ${fetchedAsins.length} total (${existingAsins.size} already processed)`);
      
      if (uniqueAsins.length === 0) {
        toast({ 
          title: 'All ASINs already processed', 
          description: 'All ASINs from storage have already been scanned.',
        });
        setProcessing(false);
        return;
      }
      
      console.log('ASINs to process:', uniqueAsins.length);

      // Create a new virtual batch from all ASINs in storage
      const { data: newBatch, error: batchError } = await supabase
        .from('asin_batches')
        .insert({
          user_id: user?.id,
          filename: 'Storage Scan - ' + new Date().toLocaleString(),
          total: uniqueAsins.length,
          processed: 0,
          status: 'queued'
        })
        .select()
        .single();

      if (batchError) {
        console.error('Error creating batch:', batchError);
        throw batchError;
      }

      console.log('Created batch:', newBatch.id);

      // Insert all unique ASINs into the new batch
      const itemsToInsert = uniqueAsins.map((asin, idx) => ({
        batch_id: newBatch.id,
        asin,
        idx,
        status: 'queued'
      }));

      // Insert in chunks to avoid payload limits
      const insertChunkSize = 1000;
      for (let i = 0; i < itemsToInsert.length; i += insertChunkSize) {
        const chunk = itemsToInsert.slice(i, i + insertChunkSize);
        const { error: insertError } = await supabase.from('asin_items').insert(chunk);
        if (insertError) throw insertError;
      }

      // Update batch total
      await supabase
        .from('asin_batches')
        .update({ total: uniqueAsins.length })
        .eq('id', newBatch.id);

      setSelectedBatch(newBatch.id);
      await fetchBatches();

      toast({ 
        title: 'Storage scan started', 
        description: `Processing ${uniqueAsins.length} unique ASINs from storage` 
      });

      // Start processing the new batch
      // First fetch Amazon data
      const fetchAmazonData = async (): Promise<boolean> => {
        try {
          const { data, error } = await supabase.functions.invoke('admin-process-asin-batch', {
            body: {
              batch_id: newBatch.id,
              page_size: pageSize,
              useGoogle: false,
              useShopping: false,
            },
          });

          if (error) throw error;

          await fetchBatches();
          await fetchItems(newBatch.id);

          if (data?.canceled) {
            return false;
          }

          if (data.remaining > 0) {
            await delay(1000);
            return await fetchAmazonData();
          }
          
          return true; // Amazon data fetch complete
        } catch (error: any) {
          console.error('Error fetching Amazon data:', error);
          toast({ title: 'Error fetching Amazon data', description: error.message, variant: 'destructive' });
          return false;
        }
      };

      // Then process Google with ScrapingBee fallback (built into admin-process-asin-batch)
      const processGoogleStep = async (): Promise<void> => {
        try {
          const { data, error } = await supabase.functions.invoke('admin-process-asin-batch', {
            body: {
              batch_id: newBatch.id,
              page_size: pageSize,
              useGoogle,
              useShopping,
            },
          });

          if (error) throw error;

          await fetchBatches();
          await fetchItems(newBatch.id);

          if (data?.canceled) {
            return;
          }

          if (data.remaining > 0) {
            await delay(1000);
            return await processGoogleStep();
          } else {
            setProcessing(false);
            setShowResults(true);
            toast({ 
              title: 'Storage scan completed', 
              description: `Successfully processed ${data?.processed ?? 0} items. Click "Show Results" to view data.`,
            });
          }
        } catch (error: any) {
          console.error('Error processing scan:', error);
          throw error;
        }
      };

      // Execute: Amazon data first, then Google + ScrapingBee fallback
      await fetchAmazonData();
      await processGoogleStep();
      
      // Always reset processing state when done
      setProcessing(false);
    } catch (error: any) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
      setProcessing(false);
    }
  };

  const handleExport = async () => {
    if (!selectedBatch) return;

    try {
      const params = new URLSearchParams({
        batch_id: selectedBatch,
        min_score: minScore[0].toString(),
        min_roi: minRoi[0].toString(),
      });

      const { data: session } = await supabase.auth.getSession();
      const token = session?.session?.access_token;

      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/admin-export-asin-batch?${params}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      if (!response.ok) throw new Error('Export failed');

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `asin_batch_${selectedBatch}.csv`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);

      toast({ title: 'Success', description: 'Export downloaded' });
    } catch (error: any) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    }
  };

  const handleDeleteBatch = async (batchId: string) => {
    try {
      const { error } = await supabase
        .from('asin_batches')
        .delete()
        .eq('id', batchId);

      if (error) throw error;

      toast({ title: 'Success', description: 'Batch deleted' });
      
      if (selectedBatch === batchId) {
        setSelectedBatch(null);
        setItems([]);
        setShowResults(false);
      }
      
      fetchBatches();
    } catch (error: any) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    }
  };

  const handleCancelBatch = async (batchId: string) => {
    try {
      const { error } = await supabase
        .from('asin_batches')
        .update({ status: 'canceled' })
        .eq('id', batchId);
      if (error) throw error;
      if (selectedBatch === batchId) {
        setProcessing(false);
      }
      toast({ title: 'Canceled', description: 'Batch processing canceled. You can view partial results.' });
      fetchBatches();
    } catch (error: any) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    }
  };

  const handleManualScrape = async () => {
    if (!manualAsins.trim()) {
      toast({ 
        title: 'No ASINs provided', 
        description: 'Please enter at least one ASIN',
        variant: 'destructive' 
      });
      return;
    }

    setManualProcessing(true);

    try {
      // Parse comma-separated ASINs
      const inputAsins = manualAsins
        .split(',')
        .map(asin => asin.trim().toUpperCase())
        .filter(asin => asin.length > 0);

      if (inputAsins.length === 0) {
        toast({ 
          title: 'No valid ASINs', 
          description: 'Please enter valid ASINs separated by commas',
          variant: 'destructive' 
        });
        return;
      }

      // Get already processed ASINs to avoid duplicates
      const { data: existingItems } = await supabase
        .from('asin_items')
        .select('asin');
      
      const existingAsins = new Set(existingItems?.map(item => item.asin) || []);
      
      // Filter out already processed ASINs
      const uniqueAsins = inputAsins.filter(asin => !existingAsins.has(asin));
      
      console.log(`Filtered ASINs: ${uniqueAsins.length} new out of ${inputAsins.length} total (${existingAsins.size} already processed)`);
      
      if (uniqueAsins.length === 0) {
        toast({ 
          title: 'All ASINs already processed', 
          description: 'All entered ASINs have already been scanned.',
        });
        return;
      }

      // Create a new batch from manual ASINs
      const { data: newBatch, error: batchError } = await supabase
        .from('asin_batches')
        .insert({
          user_id: user?.id,
          filename: 'Manual Input - ' + new Date().toLocaleString(),
          total: uniqueAsins.length,
          processed: 0,
          status: 'queued'
        })
        .select()
        .single();

      if (batchError) {
        console.error('Error creating batch:', batchError);
        throw batchError;
      }

      console.log('Created batch:', newBatch.id);

      // Insert all unique ASINs into the new batch
      const itemsToInsert = uniqueAsins.map((asin, idx) => ({
        batch_id: newBatch.id,
        asin,
        idx,
        status: 'queued',
        source_type: 'scrapingbee'
      }));

      const { error: insertError } = await supabase.from('asin_items').insert(itemsToInsert);
      if (insertError) throw insertError;

      setSelectedBatch(newBatch.id);
      await fetchBatches();

        toast({
          title: 'Smart scan started', 
          description: `Processing ${uniqueAsins.length} ASIN(s) with Google + ScrapingBee fallback` 
        });

      // First fetch Amazon data using the regular API
      const fetchAmazonData = async (): Promise<boolean> => {
        try {
          const { data, error } = await supabase.functions.invoke('admin-process-asin-batch', {
            body: {
              batch_id: newBatch.id,
              page_size: pageSize,
              useGoogle: false,
              useShopping: false,
            },
          });

          if (error) throw error;

          await fetchBatches();
          await fetchItems(newBatch.id);

          if (data?.canceled) {
            return false;
          }

          if (data.remaining > 0) {
            await delay(1000);
            return await fetchAmazonData();
          }
          
          return true;
        } catch (error: any) {
          console.error('Error fetching Amazon data:', error);
          toast({ title: 'Error fetching Amazon data', description: error.message, variant: 'destructive' });
          return false;
        }
      };

      // Then process Google based on Processing Controls (Shopping/Web)
      const processGoogleStep = async (): Promise<void> => {
        try {
          const { data, error } = await supabase.functions.invoke('admin-process-asin-batch', {
            body: {
              batch_id: newBatch.id,
              page_size: pageSize,
              useGoogle,
              useShopping,
            },
          });

          if (error) throw error;

          await fetchBatches();
          await fetchItems(newBatch.id);

          if (data?.canceled) {
            return;
          }

          if (data.remaining > 0) {
            await delay(1000);
            return await processGoogleStep();
          } else {
            setSelectedBatch(newBatch.id);
            setShowResults(true);
            toast({ 
              title: 'Manual scrape completed', 
              description: `Successfully processed ${data?.processed ?? data?.successful ?? 0} items. Click "Show Results" to view data.`,
            });
          }
        } catch (error: any) {
          console.error('Error processing Google step:', error);
          throw error;
        }
      };

      // Execute: Amazon data first, then Google scrape
      if (useGoogle || useShopping) {
        await processGoogleStep();
      } else {
        setSelectedBatch(newBatch.id);
        setShowResults(true);
        toast({
          title: 'Manual scrape completed',
          description: 'Amazon-only processing complete. Click "Show Results" to view data.',
        });
      }
      
      // Clear the input
      setManualAsins('');
    } catch (error: any) {
      toast({ 
        title: 'Manual scrape failed', 
        description: error.message || 'Please retry',
        variant: 'destructive' 
      });
    } finally {
      // Always reset state
      setManualProcessing(false);
    }
  };

  if (isAdmin === null) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  if (isAdmin === false) {
    return <Navigate to="/" replace />;
  }

  const selectedBatchData = batches.find(b => b.id === selectedBatch);
  const canShowResults = !!selectedBatchData && (
    selectedBatchData.status === 'done' ||
    selectedBatchData.status === 'canceled' ||
    (!!selectedBatchData.total && selectedBatchData.processed >= selectedBatchData.total)
  );

  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <div className="container mx-auto py-8 px-4">
        <h1 className="text-4xl font-bold mb-8">Admin ASIN Upload</h1>

        <Card className="mb-8">
          <CardHeader>
            <CardTitle>Upload ASIN Excel File</CardTitle>
            <CardDescription>Upload .xlsx file with ASIN column</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="file">Excel File</Label>
              <Input
                ref={fileInputRef}
                id="file"
                type="file"
                accept=".xlsx"
                onChange={handleFileChange}
                disabled={uploading}
              />
            </div>
            <div className="space-y-4">
              <div className="flex gap-4">
                <Button onClick={handleUpload} disabled={uploading || !file}>
                  {uploading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
                  Upload
                </Button>
              </div>
              
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Scan from Storage - Max ASINs: {scanLimit.toLocaleString()}</Label>
                  <span className="text-xs text-muted-foreground">10 → 100K</span>
                </div>
                <div className="flex gap-4 items-center">
                  <div className="flex-1 space-y-2">
                    <Slider
                      value={[Math.log10(scanLimit)]}
                      onValueChange={(value) => setScanLimit(Math.round(Math.pow(10, value[0])))}
                      min={1}
                      max={5}
                      step={1}
                      className="w-full"
                    />
                    <div className="flex flex-wrap gap-2">
                      {[10, 100, 1000, 10000, 100000].map((v) => (
                        <Button
                          key={v}
                          type="button"
                          variant={scanLimit === v ? 'default' : 'outline'}
                          size="sm"
                          onClick={() => setScanLimit(v)}
                        >
                          {v.toLocaleString()}
                        </Button>
                      ))}
                    </div>
                  </div>
                  <Button 
                    onClick={handleScanFromStorage}
                    disabled={processing}
                    variant="secondary"
                    className="shrink-0"
                  >
                    {processing ? (
                      <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Scanning...</>
                    ) : (
                      <><Play className="mr-2 h-4 w-4" /> Scan from Storage</>
                    )}
                  </Button>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="mb-8">
          <CardHeader>
            <CardTitle>Manual ASIN Input</CardTitle>
            <CardDescription>Enter ASINs separated by commas (e.g., B08N5WRWNW, B07ZPKN6YR)</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="manual-asins">ASINs (comma-separated)</Label>
              <Textarea
                id="manual-asins"
                placeholder="Enter ASINs separated by commas... (e.g., B08N5WRWNW, B07ZPKN6YR, B09G9FPHY6)"
                value={manualAsins}
                onChange={(e) => setManualAsins(e.target.value)}
                disabled={manualProcessing}
                rows={4}
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground mt-1">
                You can enter 1 or more ASINs to test scraping
              </p>
            </div>
            <Button 
              onClick={handleManualScrape}
              disabled={manualProcessing || !manualAsins.trim()}
              variant="default"
            >
              {manualProcessing ? (
                <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Scraping...</>
              ) : (
                <><Play className="mr-2 h-4 w-4" /> Smart Scan (Google + Bee)</>
              )}
            </Button>
          </CardContent>
        </Card>

        <Card className="mb-8">
          <CardHeader>
            <CardTitle>Select Batch</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {batches.map(batch => (
                <div
                  key={batch.id}
                  className={`p-4 border rounded ${
                    selectedBatch === batch.id ? 'border-primary bg-accent' : 'hover:border-muted-foreground cursor-pointer'
                  }`}
                >
                  <div 
                    className="flex justify-between items-center"
                    onClick={() => setSelectedBatch(batch.id)}
                  >
                    <div className="flex-1">
                      <p className="font-semibold">{batch.filename}</p>
                      <p className="text-sm text-muted-foreground">
                        {batch.processed}/{batch.total} processed • Status: {batch.status}
                        {batch.skipped_duplicates > 0 && ` • ${batch.skipped_duplicates} duplicates skipped`}
                      </p>
                    </div>
                    <div className="flex items-center gap-4">
                      <p className="text-sm">{new Date(batch.created_at).toLocaleDateString()}</p>
                      {(batch.status === 'running' || batch.status === 'queued') && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCancelBatch(batch.id);
                          }}
                        >
                          Cancel
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteBatch(batch.id);
                        }}
                        className="text-destructive hover:text-destructive hover:bg-destructive/10"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {selectedBatch && (
          <>
            <Card className="mb-8">
              <CardHeader>
                <CardTitle>Processing Controls</CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="flex items-center space-x-4">
                  <div className="flex items-center space-x-2">
                    <Checkbox
                      id="shopping"
                      checked={useShopping}
                      onCheckedChange={(checked) => setUseShopping(!!checked)}
                    />
                    <Label htmlFor="shopping">Google Shopping</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Checkbox
                      id="web"
                      checked={useGoogle}
                      onCheckedChange={(checked) => setUseGoogle(!!checked)}
                    />
                    <Label htmlFor="web">Google Web</Label>
                  </div>
                </div>

                <div>
                  <Label>Batch Size: {pageSize} items (per API call)</Label>
                  <Input
                    type="number"
                    value={pageSize}
                    onChange={(e) => setPageSize(Number(e.target.value))}
                     min={1}
                     max={1000}
                   />
                </div>

                <div>
                  <Label>Min ROI %: {minRoi[0]}</Label>
                  <Slider
                    value={minRoi}
                    onValueChange={setMinRoi}
                    max={100}
                    step={1}
                    className="mt-2"
                  />
                </div>

                <div>
                  <Label>Min Match Score: {minScore[0]}</Label>
                  <Slider
                    value={minScore}
                    onValueChange={setMinScore}
                    max={100}
                    step={1}
                    className="mt-2"
                  />
                </div>

                <div className="flex items-end gap-4">
                  <Button
                    onClick={handleProcess}
                    disabled={processing || selectedBatchData?.status === 'done'}
                  >
                    {processing ? (
                      <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Processing...</>
                    ) : (
                      <><Play className="mr-2 h-4 w-4" /> Start Processing</>
                    )}
                  </Button>
                  <Button onClick={handleExport} variant="outline">
                    <Download className="mr-2 h-4 w-4" /> Export CSV
                  </Button>
                </div>

                {/* Multi-select Category Filter */}
                <div className="mt-4">
                  <div className="flex items-center justify-between mb-2">
                    <Label>Category Filter ({selectedCategories.length}/20 selected)</Label>
                    {selectedCategories.length > 0 && (
                      <Button 
                        variant="ghost" 
                        size="sm"
                        onClick={() => setSelectedCategories([])}
                      >
                        Clear All
                      </Button>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2 p-4 border rounded-md bg-muted/30 min-h-[60px]">
                    {availableCategories.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No categories available</p>
                    ) : (
                      availableCategories.map((category) => {
                        const isSelected = selectedCategories.includes(category);
                        return (
                          <button
                            key={category}
                            type="button"
                            onClick={() => {
                              if (isSelected) {
                                setSelectedCategories(prev => prev.filter(c => c !== category));
                              } else if (selectedCategories.length < 20) {
                                setSelectedCategories(prev => [...prev, category]);
                              } else {
                                toast({
                                  title: 'Limit reached',
                                  description: 'You can select up to 20 categories at a time',
                                  variant: 'destructive',
                                });
                              }
                            }}
                            className={`px-3 py-1.5 text-sm rounded-md transition-all ${
                              isSelected
                                ? 'bg-primary text-primary-foreground font-medium shadow-sm'
                                : 'bg-background border border-input hover:bg-accent hover:text-accent-foreground'
                            }`}
                          >
                            {category}
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>

                <div className="flex items-end gap-4 mt-4">
                  
                  <div className="flex-1 max-w-xs">
                    <Label>Display ROI Filter: {displayMinRoi[0]}%</Label>
                    <Slider
                      value={displayMinRoi}
                      onValueChange={setDisplayMinRoi}
                      max={100}
                      step={1}
                      className="mt-2"
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      Items without ROI will still appear; filter applies when ROI is available (excludes Amazon.com)
                    </p>
                  </div>
                  
                  <div className="flex-1 max-w-xs">
                    <Label>Match Score Filter: {displayMinMatchScore[0]}%</Label>
                    <Slider
                      value={displayMinMatchScore}
                      onValueChange={setDisplayMinMatchScore}
                      max={100}
                      step={1}
                      className="mt-2"
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      Filter by product match accuracy
                    </p>
                  </div>
                  
                  <Button 
                    onClick={() => setShowResults(!showResults)} 
                    variant="default"
                    disabled={!canShowResults}
                  >
                    {showResults ? 'Hide Results' : 'Show Results'}
                  </Button>
                </div>
              </CardContent>
            </Card>

            {showResults && (
            <Card>
              <CardHeader>
                <CardTitle>Results ({getDisplayItems().length} items)</CardTitle>
              </CardHeader>
              <CardContent>
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
                        <th className="p-2 text-center font-semibold">Source</th>
                        <th className="p-2 text-right font-semibold">Match Score</th>
                        <th className="p-2 text-right font-semibold">ROI %</th>
                        <th className="p-2 text-right font-semibold">Margin %</th>
                        <th className="p-2 text-center font-semibold">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {getDisplayItems().map((item) => {
                        const isNoResults = item.status === 'failed' && item.error === 'No results found';
                        
                        return (
                        <tr key={item.id} className="border-b hover:bg-accent/50">
                          <td className="p-2">{item.idx}</td>
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
                          {isNoResults ? (
                            <td colSpan={6} className="p-2 text-center">
                              <span className="text-sm font-medium text-muted-foreground italic">
                                No retailer results found
                              </span>
                            </td>
                          ) : (
                            <>
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
                              <td className="p-2 text-center">
                                {(() => {
                                  const src: string | undefined = (item as any).source || item.source_type;
                                  const badgeClass =
                                    src === 'shopping'
                                      ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
                                      : src === 'google'
                                      ? 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200'
                                      : src === 'scraper'
                                      ? 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200'
                                      : src === 'scrapingbee'
                                      ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
                                      : src === 'api'
                                      ? 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200'
                                      : 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200';
                                  const label =
                                    src === 'shopping'
                                      ? '🛒 Shopping'
                                      : src === 'google'
                                      ? '🌐 Google'
                                      : src === 'scraper'
                                      ? '[HTTP]'
                                      : src === 'scrapingbee'
                                      ? '🐝 ScrapingBee'
                                      : src === 'api'
                                      ? '🔌 API'
                                      : src || '-';
                                  return (
                                    <span className={`text-xs px-2 py-1 rounded font-medium ${badgeClass}`}>
                                      {label}
                                    </span>
                                  );
                                })()}
                              </td>
                              <td className="p-2 text-right font-medium">{item.match_score ?? '-'}</td>
                            </>
                          )}
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
                                  : item.status === 'failed'
                                  ? 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'
                                  : item.status === 'error'
                                  ? 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'
                                  : 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200'
                              }`}
                            >
                              {item.status}
                            </span>
                          </td>
                        </tr>
                      );
                      })}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
            )}
          </>
        )}
      </div>
    </div>
  );
}
