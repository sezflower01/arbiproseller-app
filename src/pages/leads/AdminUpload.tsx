import { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Slider } from '@/components/ui/slider';
import { useToast } from '@/hooks/use-toast';
import { Upload, Play, Pause, Download, Loader2 } from 'lucide-react';
import { Navigate } from 'react-router-dom';
import Navbar from '@/components/Navbar';

export default function AdminUpload() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [batches, setBatches] = useState<any[]>([]);
  const [selectedBatch, setSelectedBatch] = useState<string | null>(null);
  const [items, setItems] = useState<any[]>([]);
  const [useGoogleShopping, setUseGoogleShopping] = useState(true);
  const [useGoogleWeb, setUseGoogleWeb] = useState(true);
  const [pageSize, setPageSize] = useState(200);
  const [minRoi, setMinRoi] = useState([0]);
  const [minScore, setMinScore] = useState([0]);

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
      .from('keepa_batches')
      .select('*')
      .order('created_at', { ascending: false });

    if (!error && data) {
      setBatches(data);
    }
  };

  const fetchItems = async (batchId: string) => {
    let query = supabase
      .from('keepa_items')
      .select('*')
      .eq('batch_id', batchId)
      .order('idx');

    // Get all items first
    const { data: allItems, error } = await query;
    
    if (error || !allItems) {
      if (!error) setItems([]);
      return;
    }

    // Filter in memory to include "no results" items
    const filtered = allItems.filter(item => {
      // Always include items with "No results found"
      if (item.status === 'failed' && item.error === 'No results found') {
        return true;
      }
      
      // Filter by score and ROI
      if (minScore[0] > 0 && (item.match_score ?? 0) < minScore[0]) {
        return false;
      }
      if (minRoi[0] > 0 && (item.roi ?? 0) < minRoi[0]) {
        return false;
      }
      
      return item.roi !== null && item.roi !== undefined;
    });
    
    setItems(filtered);
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

      const { data, error } = await supabase.functions.invoke('admin-upload-keepa-xlsx', {
        body: formData,
      });

      if (error) throw error;

      toast({ title: 'Success', description: `Uploaded ${data.total_rows} items` });
      setFile(null);
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

    setProcessing(true);

    const processChunk = async () => {
      try {
        const { data, error } = await supabase.functions.invoke('admin-process-keepa-batch', {
          body: {
            batch_id: selectedBatch,
            page_size: pageSize,
            general: useGoogleWeb,
            shopping: useGoogleShopping,
          },
        });

        if (error) throw error;

        // Refresh data
        await fetchBatches();
        await fetchItems(selectedBatch);

        if (data.remaining > 0 && processing) {
          // Continue processing
          setTimeout(processChunk, 3000);
        } else {
          setProcessing(false);
          toast({ title: 'Complete', description: 'Batch processing finished' });
        }
      } catch (error: any) {
        toast({ title: 'Error', description: error.message, variant: 'destructive' });
        setProcessing(false);
      }
    };

    await processChunk();
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
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/admin-export-keepa-batch?${params}`,
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
      a.download = `keepa_batch_${selectedBatch}.csv`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);

      toast({ title: 'Success', description: 'Export downloaded' });
    } catch (error: any) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
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

  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <div className="container mx-auto py-8 px-4">
        <h1 className="text-4xl font-bold mb-8">Admin Keepa Upload</h1>

        {/* Upload Section */}
        <Card className="mb-8">
          <CardHeader>
            <CardTitle>Upload Keepa Excel File</CardTitle>
            <CardDescription>Upload .xlsx file with ASIN and Title columns</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="file">Excel File</Label>
              <Input
                id="file"
                type="file"
                accept=".xlsx"
                onChange={handleFileChange}
                disabled={uploading}
              />
            </div>
            <Button onClick={handleUpload} disabled={uploading || !file}>
              {uploading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
              Upload
            </Button>
          </CardContent>
        </Card>

        {/* Batch Selection */}
        <Card className="mb-8">
          <CardHeader>
            <CardTitle>Select Batch</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {batches.map(batch => (
                <div
                  key={batch.id}
                  className={`p-4 border rounded cursor-pointer ${
                    selectedBatch === batch.id ? 'border-primary bg-accent' : ''
                  }`}
                  onClick={() => setSelectedBatch(batch.id)}
                >
                  <div className="flex justify-between items-center">
                    <div>
                      <p className="font-semibold">{batch.filename}</p>
                      <p className="text-sm text-muted-foreground">
                        {batch.processed_rows}/{batch.total_rows} processed • Status: {batch.status}
                      </p>
                    </div>
                    <p className="text-sm">{new Date(batch.created_at).toLocaleDateString()}</p>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {selectedBatch && (
          <>
            {/* Processing Controls */}
            <Card className="mb-8">
              <CardHeader>
                <CardTitle>Processing Controls</CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="flex items-center space-x-4">
                  <div className="flex items-center space-x-2">
                    <Checkbox
                      id="shopping"
                      checked={useGoogleShopping}
                      onCheckedChange={(checked) => setUseGoogleShopping(!!checked)}
                    />
                    <Label htmlFor="shopping">Google Shopping</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Checkbox
                      id="web"
                      checked={useGoogleWeb}
                      onCheckedChange={(checked) => setUseGoogleWeb(!!checked)}
                    />
                    <Label htmlFor="web">Google Web</Label>
                  </div>
                </div>

                <div>
                  <Label>Page Size: {pageSize}</Label>
                  <Input
                    type="number"
                    value={pageSize}
                    onChange={(e) => setPageSize(Number(e.target.value))}
                    min={1}
                    max={500}
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

                <div className="flex space-x-4">
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
              </CardContent>
            </Card>

            {/* Results Table */}
            <Card>
              <CardHeader>
                <CardTitle>Results ({items.length} items)</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse">
                    <thead>
                      <tr className="border-b">
                        <th className="p-2 text-left">#</th>
                        <th className="p-2 text-left">Retailer</th>
                        <th className="p-2 text-left">Price</th>
                        <th className="p-2 text-left">Amazon</th>
                        <th className="p-2 text-left">Price</th>
                        <th className="p-2 text-right">Match</th>
                        <th className="p-2 text-right">ROI %</th>
                        <th className="p-2 text-left">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((item) => {
                        const isNoResults = item.status === 'failed' && item.error === 'No results found';
                        
                        return (
                        <tr key={item.id} className="border-b hover:bg-accent">
                          <td className="p-2">{item.idx}</td>
                          {isNoResults ? (
                            <>
                              <td className="p-2">
                                <div className="flex items-center space-x-2">
                                  {item.amz_image && (
                                    <img src={item.amz_image} alt="" className="w-12 h-12 object-cover rounded" />
                                  )}
                                  <div>
                                    <p className="text-xs text-muted-foreground truncate max-w-[200px]">
                                      {item.amz_title}
                                    </p>
                                    {item.amz_asin && (
                                      <a
                                        href={`https://www.amazon.com/dp/${item.amz_asin}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-xs text-primary hover:underline"
                                      >
                                        {item.amz_asin}
                                      </a>
                                    )}
                                  </div>
                                </div>
                              </td>
                              <td colSpan={3} className="p-2 text-center">
                                <span className="text-sm font-medium text-muted-foreground italic">
                                  No retailer results found
                                </span>
                              </td>
                              <td className="p-2">${item.amz_price?.toFixed(2) || '-'}</td>
                            </>
                          ) : (
                            <>
                              <td className="p-2">
                                <div className="flex items-center space-x-2">
                                  {item.g_image && (
                                    <img src={item.g_image} alt="" className="w-12 h-12 object-cover rounded" />
                                  )}
                                  <div>
                                    <p className="text-sm font-medium">{item.g_store}</p>
                                    <p className="text-xs text-muted-foreground truncate max-w-[200px]">
                                      {item.g_title}
                                    </p>
                                  </div>
                                </div>
                              </td>
                              <td className="p-2">${item.g_price?.toFixed(2) || '-'}</td>
                              <td className="p-2">
                                <div className="flex items-center space-x-2">
                                  {item.amz_image && (
                                    <img src={item.amz_image} alt="" className="w-12 h-12 object-cover rounded" />
                                  )}
                                  <div>
                                    <p className="text-xs text-muted-foreground truncate max-w-[200px]">
                                      {item.amz_title}
                                    </p>
                                    {item.amz_asin && (
                                      <a
                                        href={`https://www.amazon.com/dp/${item.amz_asin}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-xs text-primary hover:underline"
                                      >
                                        {item.amz_asin}
                                      </a>
                                    )}
                                  </div>
                                </div>
                              </td>
                              <td className="p-2">${item.amz_price?.toFixed(2) || '-'}</td>
                            </>
                          )}
                          <td className="p-2 text-right">{item.match_score || '-'}</td>
                          <td className="p-2 text-right">
                            <span className={item.roi > 20 ? 'text-green-600 font-semibold' : ''}>
                              {item.roi?.toFixed(1) || '-'}%
                            </span>
                          </td>
                          <td className="p-2">
                            <span
                              className={`text-xs px-2 py-1 rounded ${
                                item.status === 'done'
                                  ? 'bg-green-100 text-green-800'
                                  : item.status === 'failed'
                                  ? 'bg-red-100 text-red-800'
                                  : item.status === 'error'
                                  ? 'bg-red-100 text-red-800'
                                  : 'bg-yellow-100 text-yellow-800'
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
          </>
        )}
      </div>
    </div>
  );
}