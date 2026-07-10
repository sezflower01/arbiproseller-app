import { useState, useCallback } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Loader2, DollarSign, Calendar, RefreshCw, Download } from "lucide-react";
import { toast } from "sonner";
import { format, subMonths } from "date-fns";
import * as XLSX from 'xlsx';
import Navbar from "@/components/Navbar";

interface Settlement {
  id: string;
  status: string;
  fundTransferStatus: string;
  fundTransferDate: string | null;
  originalTotal: number;
  currency: string;
  convertedTotal: number;
  beginningBalance: number;
  accountTail: string;
  traceId: string;
  periodStart: string;
  periodEnd: string;
}

export default function Settlement() {
  const { user } = useAuth();
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [loading, setLoading] = useState(false);
  const [startDate, setStartDate] = useState(() => format(subMonths(new Date(), 3), 'yyyy-MM-dd'));
  const [endDate, setEndDate] = useState(() => format(new Date(), 'yyyy-MM-dd'));
  const [totalCost, setTotalCost] = useState<number>(0);
  const [costLoading, setCostLoading] = useState(false);

  const fetchSettlements = useCallback(async () => {
    if (!user) {
      toast.error("Please log in to view settlements");
      return;
    }

    setLoading(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;

      if (!token) {
        toast.error("Session expired. Please log in again.");
        return;
      }

      const response = await supabase.functions.invoke('fetch-settlements', {
        body: {
          startDate: new Date(startDate).toISOString(),
          endDate: new Date(endDate + 'T23:59:59').toISOString(),
        },
      });

      if (response.error) {
        throw new Error(response.error.message || 'Failed to fetch settlements');
      }

      const data = response.data;
      if (data.error) {
        throw new Error(data.error);
      }

      setSettlements(data.settlements || []);
      toast.success(`Found ${data.settlements?.length || 0} settlements`);
    } catch (error: any) {
      console.error('Error fetching settlements:', error);
      toast.error(error.message || 'Failed to fetch settlements');
    } finally {
      setLoading(false);
    }
  }, [user, startDate, endDate]);

  const fetchTotalCost = useCallback(async () => {
    if (!user) return;
    
    setCostLoading(true);
    try {
      const { data, error } = await supabase
        .from('created_listings')
        .select('cost')
        .eq('user_id', user.id);

      if (error) throw error;

      const total = (data || []).reduce((sum, item) => sum + (item.cost || 0), 0);
      setTotalCost(total);
    } catch (error: any) {
      console.error('Error fetching total cost:', error);
      toast.error('Failed to fetch total cost');
    } finally {
      setCostLoading(false);
    }
  }, [user]);

  const formatCurrency = (amount: number, currency: string = 'USD') => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency,
    }).format(amount);
  };

  const formatDate = (dateString: string | null) => {
    if (!dateString) return '—';
    try {
      return format(new Date(dateString), 'MMM dd, yyyy');
    } catch {
      return dateString;
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'Closed':
        return <Badge variant="default" className="bg-green-600">Closed</Badge>;
      case 'Open':
        return <Badge variant="secondary">Open</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const getFundTransferBadge = (status: string) => {
    switch (status) {
      case 'Succeeded':
        return <Badge variant="default" className="bg-green-600">Succeeded</Badge>;
      case 'Failed':
        return <Badge variant="destructive">Failed</Badge>;
      case 'Initiated':
        return <Badge variant="secondary">Initiated</Badge>;
      default:
        return <Badge variant="outline">{status || '—'}</Badge>;
    }
  };

  // Currency conversion rates to USD
  const convertToUSD = (amount: number, currency: string): number => {
    const rates: Record<string, number> = {
      'USD': 1,
      'CAD': 0.73,
      'MXN': 0.05,
      'BRL': 0.17,
    };
    return amount * (rates[currency] || 1);
  };

  const totalPaid = settlements
    .filter(s => s.fundTransferStatus === 'Succeeded' && s.status !== 'Open')
    .reduce((sum, s) => sum + convertToUSD(s.originalTotal, s.currency), 0);

  const totalPending = settlements
    .filter(s => s.status === 'Open')
    .reduce((sum, s) => sum + convertToUSD(s.originalTotal, s.currency), 0);

  const profitLoss = totalPaid - totalCost;

  const exportToExcel = () => {
    const succeededSettlements = settlements.filter(s => s.fundTransferStatus === 'Succeeded');
    
    if (succeededSettlements.length === 0) {
      toast.error("No succeeded settlements to export");
      return;
    }

    const exportData = succeededSettlements.map(s => ({
      'Period Start': formatDate(s.periodStart),
      'Period End': formatDate(s.periodEnd),
      'Transfer Date': formatDate(s.fundTransferDate),
      'Amount': s.originalTotal,
      'Currency': s.currency,
      'Amount (USD)': convertToUSD(s.originalTotal, s.currency).toFixed(2),
      'Account': s.accountTail ? `****${s.accountTail}` : '',
      'Trace ID': s.traceId || '',
    }));

    // Add totals row
    const totalsRow = {
      'Period Start': 'TOTALS',
      'Period End': '',
      'Transfer Date': '',
      'Amount': succeededSettlements.reduce((sum, s) => sum + s.originalTotal, 0),
      'Currency': 'MIXED',
      'Amount (USD)': totalPaid.toFixed(2),
      'Account': '',
      'Trace ID': '',
    };
    exportData.push(totalsRow);

    const ws = XLSX.utils.json_to_sheet(exportData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Settlements');
    
    const filename = `amazon_settlements_${startDate}_to_${endDate}.xlsx`;
    XLSX.writeFile(wb, filename);
    toast.success(`Exported ${succeededSettlements.length} settlements`);
  };

  return (
    <>
      <Navbar />
      <div className="container mx-auto py-6 px-4 max-w-7xl pt-24">
        <div className="flex flex-col gap-6">
          {/* Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold">Amazon Settlements</h1>
            <p className="text-muted-foreground">View Amazon payment disbursements to your bank account</p>
          </div>
        </div>

        {/* Filters */}
        <Card>
          <CardContent className="pt-6">
            <div className="flex flex-wrap items-end gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="startDate">Start Date</Label>
                <Input
                  id="startDate"
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="w-[160px]"
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="endDate">End Date</Label>
                <Input
                  id="endDate"
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  className="w-[160px]"
                />
              </div>
              <Button onClick={fetchSettlements} disabled={loading}>
                {loading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Loading...
                  </>
                ) : (
                  <>
                    <RefreshCw className="mr-2 h-4 w-4" />
                    Fetch Settlements
                  </>
                )}
              </Button>
              <Button variant="secondary" onClick={fetchTotalCost} disabled={costLoading}>
                {costLoading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Loading Cost...
                  </>
                ) : (
                  <>
                    <DollarSign className="mr-2 h-4 w-4" />
                    Calculate Cost
                  </>
                )}
              </Button>
              {settlements.length > 0 && (
                <Button variant="outline" onClick={exportToExcel}>
                  <Download className="mr-2 h-4 w-4" />
                  Export Excel
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Summary Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Total Paid</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <DollarSign className="h-5 w-5 text-green-600" />
                <span className="text-xl font-bold text-green-600">{formatCurrency(totalPaid)}</span>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Pending</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <DollarSign className="h-5 w-5 text-yellow-600" />
                <span className="text-xl font-bold text-yellow-600">{formatCurrency(totalPending)}</span>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Settlements</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <Calendar className="h-5 w-5 text-primary" />
                <span className="text-xl font-bold">{settlements.length}</span>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Total Cost</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <DollarSign className="h-5 w-5 text-red-600" />
                <span className="text-xl font-bold text-red-600">{formatCurrency(totalCost)}</span>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Profit/Loss</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <DollarSign className={`h-5 w-5 ${profitLoss >= 0 ? 'text-green-600' : 'text-red-600'}`} />
                <span className={`text-xl font-bold ${profitLoss >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                  {profitLoss >= 0 ? '+' : ''}{formatCurrency(profitLoss)}
                </span>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Margin %</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <span className={`text-xl font-bold ${profitLoss >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                  {totalPaid > 0 ? ((profitLoss / totalPaid) * 100).toFixed(1) : 0}%
                </span>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Settlements Table */}
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Period</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Transfer Status</TableHead>
                    <TableHead>Transfer Date</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Account</TableHead>
                    <TableHead>Trace ID</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {settlements.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                        {loading ? 'Loading settlements...' : 'No settlements found. Click "Fetch Settlements" to load data.'}
                      </TableCell>
                    </TableRow>
                  ) : (
                    settlements.map((settlement) => (
                      <TableRow key={settlement.id}>
                        <TableCell>
                          <div className="flex flex-col">
                            <span className="text-sm">{formatDate(settlement.periodStart)}</span>
                            <span className="text-xs text-muted-foreground">to {formatDate(settlement.periodEnd)}</span>
                          </div>
                        </TableCell>
                        <TableCell>{getStatusBadge(settlement.status)}</TableCell>
                        <TableCell>{getFundTransferBadge(settlement.fundTransferStatus)}</TableCell>
                        <TableCell>{formatDate(settlement.fundTransferDate)}</TableCell>
                        <TableCell className="text-right font-medium">
                          <span className={settlement.originalTotal >= 0 ? 'text-green-600' : 'text-red-600'}>
                            {formatCurrency(settlement.originalTotal, settlement.currency)}
                          </span>
                        </TableCell>
                        <TableCell>
                          {settlement.accountTail ? `****${settlement.accountTail}` : '—'}
                        </TableCell>
                        <TableCell>
                          <span className="text-xs text-muted-foreground font-mono">
                            {settlement.traceId || '—'}
                          </span>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
        </div>
      </div>
    </>
  );
}
