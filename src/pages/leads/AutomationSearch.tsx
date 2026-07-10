import { useState, useEffect } from "react";
import { Helmet } from "react-helmet-async";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Play, Download, Loader2, TrendingUp, Target, DollarSign } from "lucide-react";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";

interface AutomationRun {
  id: string;
  name: string;
  status: string;
  total: number;
  processed: number;
  matched: number;
  avg_roi: number | null;
  created_at: string;
}

interface AutomationResult {
  id: string;
  input_title: string;
  input_asin: string;
  g_store: string;
  g_title: string;
  g_price: number;
  g_link: string;
  g_image: string;
  amz_asin: string;
  amz_title: string;
  amz_price: number;
  amz_link: string;
  amz_image: string;
  match_score: number;
  roi: number;
  margin_pct: number;
  status: string;
}

const AutomationSearch = () => {
  const { user } = useAuth();
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [runName, setRunName] = useState("");
  const [batchSize, setBatchSize] = useState(500);
  const [minScore, setMinScore] = useState(70);
  const [minROI, setMinROI] = useState(20);
  const [currentRun, setCurrentRun] = useState<AutomationRun | null>(null);
  const [results, setResults] = useState<AutomationResult[]>([]);
  const [profile, setProfile] = useState<any>(null);
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    if (user) {
      loadProfile();
      checkAdminStatus();
    }
  }, [user]);

  useEffect(() => {
    if (currentRun) {
      subscribeToResults();
      subscribeToRunUpdates();
    }
  }, [currentRun]);

  const loadProfile = async () => {
    const { data } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user?.id)
      .single();
    setProfile(data);
  };

  const checkAdminStatus = async () => {
    const { data } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', user?.id)
      .eq('role', 'admin')
      .maybeSingle();
    setIsAdmin(!!data);
  };

  // Realtime channel scoping: user-scoped. See docs/realtime-channels.md.
  // Channel name includes user.id + run.id so each user's tabs get their own
  // topic namespace instead of sharing a global "automation-results" bus.
  const subscribeToResults = () => {
    if (!user?.id || !currentRun?.id) return () => {};
    const channel = supabase
      .channel(`automation-results-${user.id}-${currentRun.id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'automation_results',
          filter: `run_id=eq.${currentRun.id}`
        },
        (payload) => {
          setResults(prev => [...prev, payload.new as AutomationResult]);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  };

  // Realtime channel scoping: user-scoped. See docs/realtime-channels.md.
  const subscribeToRunUpdates = () => {
    if (!user?.id || !currentRun?.id) return () => {};
    const channel = supabase
      .channel(`automation-runs-${user.id}-${currentRun.id}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'automation_runs',
          filter: `id=eq.${currentRun.id}`
        },
        (payload) => {
          setCurrentRun(payload.new as AutomationRun);
          if (payload.new.status === 'done') {
            setLoading(false);
            toast({
              title: "Automation Complete",
              description: `Processed ${payload.new.processed} items with ${payload.new.matched} matches.`
            });
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  };

  const startAutomation = async () => {
    if (!user) return;

    try {
      setLoading(true);
      setResults([]);

      // Start the run
      const { data, error } = await supabase.functions.invoke('start-automation-run', {
        body: {
          name: runName || `Automation ${new Date().toLocaleString()}`,
          batchSize,
          filters: { minScore, minROI }
        }
      });

      if (error) throw error;

      // Fetch the run details
      const { data: run } = await supabase
        .from('automation_runs')
        .select('*')
        .eq('id', data.run_id)
        .single();

      setCurrentRun(run);

      // Start processing pages
      processNextPage(data.run_id);

    } catch (error: any) {
      console.error('Start error:', error);
      toast({
        title: "Error",
        description: error.message || "Failed to start automation",
        variant: "destructive"
      });
      setLoading(false);
    }
  };

  const processNextPage = async (runId: string) => {
    try {
      const { data, error } = await supabase.functions.invoke('process-automation-page', {
        body: { run_id: runId, page_size: 50 }
      });

      if (error) throw error;

      if (data.status === 'processing' && data.has_more) {
        // Continue processing
        setTimeout(() => processNextPage(runId), 3000);
      } else if (data.status === 'done') {
        setLoading(false);
      }
    } catch (error: any) {
      console.error('Processing error:', error);
      toast({
        title: "Processing Error",
        description: error.message,
        variant: "destructive"
      });
      setLoading(false);
    }
  };

  const exportResults = async () => {
    if (!currentRun) return;

    try {
      const { data, error } = await supabase.functions.invoke('export-automation-results', {
        method: 'GET',
        body: {
          run_id: currentRun.id,
          min_score: minScore,
          min_roi: minROI
        }
      });

      if (error) throw error;

      if (data.download_url) {
        window.open(data.download_url, '_blank');
        toast({
          title: "Export Ready",
          description: `Downloaded ${data.count} results`
        });
      }
    } catch (error: any) {
      toast({
        title: "Export Error",
        description: error.message,
        variant: "destructive"
      });
    }
  };

  const filteredResults = results.filter(r => 
    r.match_score >= minScore && r.roi >= minROI
  );

  const canStart = isAdmin || (profile?.credits || 0) >= batchSize;

  return (
    <div className="min-h-screen flex flex-col">
      <Helmet>
        <title>Automation Search | ArbiProSeller</title>
        <meta name="description" content="Automated product research across Google and Amazon" />
      </Helmet>

      <Navbar />

      <main className="flex-grow pt-24 pb-12">
        <div className="container mx-auto px-4">
          <div className="mb-8">
            <h1 className="text-4xl font-bold mb-2">Automation Search</h1>
            <p className="text-xl text-muted-foreground">
              Automated product research powered by Google Shopping & Amazon
            </p>
          </div>

          {/* Credits & Status */}
          <div className="grid md:grid-cols-4 gap-4 mb-8">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium">Credits</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {isAdmin ? '∞' : profile?.credits || 0}
                </div>
                <p className="text-xs text-muted-foreground">
                  {isAdmin ? 'Admin Access' : '1 credit per item'}
                </p>
              </CardContent>
            </Card>

            {currentRun && (
              <>
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-sm font-medium flex items-center gap-2">
                      <Target className="h-4 w-4" />
                      Processed
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">{currentRun.processed}</div>
                    <p className="text-xs text-muted-foreground">of {currentRun.total}</p>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-sm font-medium flex items-center gap-2">
                      <TrendingUp className="h-4 w-4" />
                      Matches
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">{currentRun.matched}</div>
                    <p className="text-xs text-muted-foreground">≥{minScore}% score</p>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-sm font-medium flex items-center gap-2">
                      <DollarSign className="h-4 w-4" />
                      Avg ROI
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">
                      {currentRun.avg_roi ? `${currentRun.avg_roi.toFixed(1)}%` : '-'}
                    </div>
                    <p className="text-xs text-muted-foreground">Return on investment</p>
                  </CardContent>
                </Card>
              </>
            )}
          </div>

          {/* Controls */}
          <Card className="mb-8">
            <CardHeader>
              <CardTitle>Run Configuration</CardTitle>
              <CardDescription>Configure and start a new automation search</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="runName">Run Name (Optional)</Label>
                  <Input
                    id="runName"
                    placeholder="e.g., Holiday Products"
                    value={runName}
                    onChange={(e) => setRunName(e.target.value)}
                    disabled={loading}
                  />
                </div>
                <div>
                  <Label htmlFor="batchSize">Batch Size</Label>
                  <Input
                    id="batchSize"
                    type="number"
                    min="10"
                    max="5000"
                    value={batchSize}
                    onChange={(e) => setBatchSize(parseInt(e.target.value))}
                    disabled={loading}
                  />
                </div>
                <div>
                  <Label htmlFor="minScore">Min Match Score (%)</Label>
                  <Input
                    id="minScore"
                    type="number"
                    min="0"
                    max="100"
                    value={minScore}
                    onChange={(e) => setMinScore(parseInt(e.target.value))}
                    disabled={loading}
                  />
                </div>
                <div>
                  <Label htmlFor="minROI">Min ROI (%)</Label>
                  <Input
                    id="minROI"
                    type="number"
                    min="0"
                    max="1000"
                    value={minROI}
                    onChange={(e) => setMinROI(parseInt(e.target.value))}
                    disabled={loading}
                  />
                </div>
              </div>

              <div className="flex gap-4">
                <Button 
                  onClick={startAutomation} 
                  disabled={loading || !canStart}
                  className="flex-1"
                >
                  {loading ? (
                    <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Processing...</>
                  ) : (
                    <><Play className="mr-2 h-4 w-4" /> Start Automation</>
                  )}
                </Button>
                {currentRun && filteredResults.length > 0 && (
                  <Button onClick={exportResults} variant="outline">
                    <Download className="mr-2 h-4 w-4" /> Export CSV
                  </Button>
                )}
              </div>

              {!canStart && !isAdmin && (
                <p className="text-sm text-destructive">
                  Insufficient credits. Need {batchSize} credits, have {profile?.credits || 0}.
                </p>
              )}
            </CardContent>
          </Card>

          {/* Results Table */}
          {filteredResults.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Results ({filteredResults.length})</CardTitle>
                <CardDescription>Matches meeting your criteria</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b">
                        <th className="text-left p-2">Input</th>
                        <th className="text-left p-2">Retailer</th>
                        <th className="text-left p-2">Amazon</th>
                        <th className="text-right p-2">Score</th>
                        <th className="text-right p-2">ROI</th>
                        <th className="text-center p-2">Links</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredResults.map((result) => (
                        <tr key={result.id} className="border-b hover:bg-muted/50">
                          <td className="p-2">
                            <div className="font-medium text-xs">{result.input_title}</div>
                            {result.input_asin && (
                              <div className="text-xs text-muted-foreground">{result.input_asin}</div>
                            )}
                          </td>
                          <td className="p-2">
                            <div className="flex items-center gap-2">
                              {result.g_image && (
                                <img src={result.g_image} alt="" className="w-10 h-10 object-cover rounded" />
                              )}
                              <div>
                                <div className="font-medium text-xs">{result.g_store}</div>
                                <div className="text-xs text-muted-foreground">${result.g_price}</div>
                              </div>
                            </div>
                          </td>
                          <td className="p-2">
                            <div className="flex items-center gap-2">
                              {result.amz_image && (
                                <img src={result.amz_image} alt="" className="w-10 h-10 object-cover rounded" />
                              )}
                              <div>
                                <div className="font-medium text-xs">{result.amz_asin}</div>
                                <div className="text-xs text-muted-foreground">${result.amz_price}</div>
                              </div>
                            </div>
                          </td>
                          <td className="p-2 text-right">
                            <span className={`font-bold ${result.match_score >= 80 ? 'text-green-600' : result.match_score >= 70 ? 'text-yellow-600' : ''}`}>
                              {result.match_score}%
                            </span>
                          </td>
                          <td className="p-2 text-right">
                            <span className={`font-bold ${result.roi >= 50 ? 'text-green-600' : result.roi >= 20 ? 'text-yellow-600' : ''}`}>
                              {result.roi.toFixed(1)}%
                            </span>
                          </td>
                          <td className="p-2 text-center">
                            <div className="flex gap-2 justify-center">
                              {result.g_link && (
                                <a href={result.g_link} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline text-xs">
                                  Retailer
                                </a>
                              )}
                              {result.amz_link && (
                                <a href={result.amz_link} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline text-xs">
                                  Amazon
                                </a>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </main>

      <Footer />
    </div>
  );
};

export default AutomationSearch;