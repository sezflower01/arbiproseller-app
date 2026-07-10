import { useState, useEffect } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { RefreshCw, AlertTriangle, Package, DollarSign, Calendar, ExternalLink, Info, Download, ArrowUpDown, ArrowUp, ArrowDown, Copy } from "lucide-react";
import Navbar from "@/components/Navbar";
import { Helmet } from "react-helmet-async";

interface ReimbursementItem {
  id: string;
  type: 'REFUND_NOT_RETURNED' | 'WAREHOUSE_LOST' | 'WAREHOUSE_DAMAGED' | 'CARRIER_LOST' | 'FEE_CORRECTION' | 'OTHER';
  asin: string;
  sku?: string;
  fnsku?: string;
  title?: string;
  imageUrl?: string;
  quantity: number;
  amount: number;
  currency: string;
  amountUSD: number;
  postedDate: string;
  orderId?: string;
  reason?: string;
  status: 'PENDING' | 'ELIGIBLE' | 'REIMBURSED' | 'DENIED';
  daysOpen?: number;
  reimbursementId?: string;
  caseId?: string;
}

interface Summary {
  totalPending: number;
  totalReimbursed: number;
  refundNotReturned: { count: number; amount: number };
  warehouseLost: { count: number; amount: number };
  warehouseDamaged: { count: number; amount: number };
  other: { count: number; amount: number };
}

function formatDate(dateStr: string): string {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function getTypeLabel(type: ReimbursementItem['type']): string {
  switch (type) {
    case 'REFUND_NOT_RETURNED': return 'Refund Not Returned';
    case 'WAREHOUSE_LOST': return 'Warehouse Lost';
    case 'WAREHOUSE_DAMAGED': return 'Warehouse Damaged';
    case 'CARRIER_LOST': return 'Carrier Lost';
    case 'FEE_CORRECTION': return 'Fee Correction';
    default: return 'Other';
  }
}

function getStatusBadge(status: ReimbursementItem['status']) {
  switch (status) {
    case 'ELIGIBLE':
      return <Badge className="bg-green-500/20 text-green-400 border-green-500/30">Eligible</Badge>;
    case 'REIMBURSED':
      return <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/30">Reimbursed</Badge>;
    case 'PENDING':
      return <Badge className="bg-yellow-500/20 text-yellow-400 border-yellow-500/30">Pending</Badge>;
    case 'DENIED':
      return <Badge className="bg-red-500/20 text-red-400 border-red-500/30">Denied</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

function copyClaimDetails(item: ReimbursementItem) {
  const details = `Order ID: ${item.orderId || 'N/A'}
ASIN: ${item.asin}
SKU: ${item.sku || 'N/A'}
Title: ${item.title || 'Unknown Product'}
Refund Date: ${formatDate(item.postedDate)}
Amount: $${item.amountUSD.toFixed(2)}
Days Since Refund: ${item.daysOpen || 'N/A'}

Claim Reason: Customer was refunded on ${formatDate(item.postedDate)} but the product was never returned to FBA inventory. Per Amazon's policy, reimbursement is due after 45 days.`;

  navigator.clipboard.writeText(details).then(() => {
    toast.success('Claim details copied to clipboard');
  }).catch(() => {
    toast.error('Failed to copy to clipboard');
  });
}

const Reimbursements = () => {
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const [reimbursements, setReimbursements] = useState<ReimbursementItem[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [lastUpdate, setLastUpdate] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('all');
  const [showOnlyEligible, setShowOnlyEligible] = useState(true);
  const [sortColumn, setSortColumn] = useState<'type' | 'status' | 'amount' | 'date' | null>(null);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const [startDate, setStartDate] = useState(() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 1); // Default to 1 year ago
    return d.toISOString().split('T')[0];
  });
  const [endDate, setEndDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [hydrated, setHydrated] = useState(false);
  const [lookupLoading, setLookupLoading] = useState<Record<string, boolean>>({});

  async function lookupReimbursementId(item: ReimbursementItem) {
    setLookupLoading(prev => ({ ...prev, [item.id]: true }));
    try {
      const { data, error } = await supabase.functions.invoke('lookup-reimbursement-id', {
        body: { orderId: item.orderId, sku: item.sku, postedDate: item.postedDate },
      });
      if (error) throw error;
      if (data?.found) {
        toast.success(`Reimbursement ID found: ${data.reimbursementId}`);
        setReimbursements(prev => prev.map(r =>
          r.id === item.id
            ? { ...r, reimbursementId: data.reimbursementId, caseId: data.caseId || undefined, status: 'REIMBURSED' as const }
            : r
        ));
      } else {
        toast.info(data?.message || 'No reimbursement record found yet');
      }
    } catch (e: any) {
      toast.error(`Lookup failed: ${e.message || 'Unknown error'}`);
    } finally {
      setLookupLoading(prev => ({ ...prev, [item.id]: false }));
    }
  }

  // Persist state so navigating away/back doesn't wipe results
  useEffect(() => {
    if (!user) return;

    const storageKey = `aps:reimbursements:${user.id}`;
    const raw = sessionStorage.getItem(storageKey);

    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        setReimbursements(parsed.reimbursements || []);
        setSummary(parsed.summary || null);
        setLastUpdate(parsed.lastUpdate || null);
        setActiveTab(parsed.activeTab || 'all');
        setShowOnlyEligible(parsed.showOnlyEligible ?? true);
        setSortColumn(parsed.sortColumn ?? null);
        setSortDirection(parsed.sortDirection || 'asc');
        if (parsed.startDate) setStartDate(parsed.startDate);
        if (parsed.endDate) setEndDate(parsed.endDate);
      } catch (e) {
        console.warn('Failed to restore reimbursements state', e);
      }
    }

    setHydrated(true);
  }, [user?.id]);

  useEffect(() => {
    if (!user || !hydrated) return;

    const storageKey = `aps:reimbursements:${user.id}`;
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({
        reimbursements,
        summary,
        lastUpdate,
        activeTab,
        showOnlyEligible,
        sortColumn,
        sortDirection,
        startDate,
        endDate,
      })
    );
  }, [
    user?.id,
    hydrated,
    reimbursements,
    summary,
    lastUpdate,
    activeTab,
    showOnlyEligible,
    sortColumn,
    sortDirection,
    startDate,
    endDate,
  ]);

  const fetchReimbursements = async () => {
    if (!user) return;
    
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke('fetch-reimbursements', {
        body: {
          start_date: startDate,
          end_date: endDate,
          type_filter: activeTab === 'all' ? null : activeTab,
        },
      });

      if (error) throw error;

      if (data.success) {
        setReimbursements(data.reimbursements || []);
        setSummary(data.summary);
        setLastUpdate(data.lastUpdate);
        toast.success(`Found ${data.reimbursements?.length || 0} reimbursement items`);
      } else {
        throw new Error(data.error || 'Failed to fetch reimbursements');
      }
    } catch (err: any) {
      console.error('Error fetching reimbursements:', err);
      toast.error(err.message || 'Failed to fetch reimbursements');
    } finally {
      setLoading(false);
    }
  };

  // Don't auto-fetch on mount - user needs to click Search to load data
  // This prevents unnecessary loading when returning to the page

  const filteredReimbursements = (() => {
    let filtered = activeTab === 'all' 
      ? reimbursements 
      : reimbursements.filter(r => {
          if (activeTab === 'returns') return r.type === 'REFUND_NOT_RETURNED';
          if (activeTab === 'lost') return r.type === 'WAREHOUSE_LOST';
          if (activeTab === 'damaged') return r.type === 'WAREHOUSE_DAMAGED';
          if (activeTab === 'other') return !['REFUND_NOT_RETURNED', 'WAREHOUSE_LOST', 'WAREHOUSE_DAMAGED'].includes(r.type);
          return true;
        });

    // Apply eligible filter
    if (showOnlyEligible) {
      filtered = filtered.filter(r => r.status === 'ELIGIBLE' || r.status === 'PENDING');
    }

    // Apply sorting
    if (sortColumn) {
      filtered = [...filtered].sort((a, b) => {
        let comparison = 0;
        
        switch (sortColumn) {
          case 'type':
            comparison = getTypeLabel(a.type).localeCompare(getTypeLabel(b.type));
            break;
          case 'status':
            comparison = a.status.localeCompare(b.status);
            break;
          case 'amount':
            comparison = a.amountUSD - b.amountUSD;
            break;
          case 'date':
            const dateA = a.postedDate ? new Date(a.postedDate).getTime() : 0;
            const dateB = b.postedDate ? new Date(b.postedDate).getTime() : 0;
            comparison = dateA - dateB;
            break;
        }
        
        return sortDirection === 'asc' ? comparison : -comparison;
      });
    }

    return filtered;
  })();

  const handleSort = (column: 'type' | 'status' | 'amount' | 'date') => {
    if (sortColumn === column) {
      // Toggle direction or clear
      if (sortDirection === 'asc') {
        setSortDirection('desc');
      } else {
        setSortColumn(null);
        setSortDirection('asc');
      }
    } else {
      setSortColumn(column);
      setSortDirection('asc');
    }
  };

  const getSortIcon = (column: 'type' | 'status' | 'amount' | 'date') => {
    if (sortColumn !== column) {
      return <ArrowUpDown className="h-4 w-4 ml-1 opacity-50" />;
    }
    return sortDirection === 'asc' 
      ? <ArrowUp className="h-4 w-4 ml-1" /> 
      : <ArrowDown className="h-4 w-4 ml-1" />;
  };

  const exportToCSV = () => {
    const headers = ['Date', 'Type', 'ASIN', 'SKU', 'Title', 'Qty', 'Amount', 'Status', 'Order ID', 'Reimbursement ID', 'Case ID', 'Reason'];
    const rows = filteredReimbursements.map(r => [
      formatDate(r.postedDate),
      getTypeLabel(r.type),
      r.asin,
      r.sku || '',
      r.title || '',
      r.quantity,
      `$${r.amountUSD.toFixed(2)}`,
      r.status,
      r.orderId || '',
      r.reimbursementId || '',
      r.caseId || '',
      r.reason || '',
    ]);

    const csv = [headers.join(','), ...rows.map(row => row.map(cell => `"${cell}"`).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `reimbursements-${startDate}-to-${endDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-background">
      <Helmet>
        <title>FBA Reimbursements | ArbiProSeller</title>
        <meta name="description" content="Track and claim Amazon FBA reimbursements for lost, damaged, and unreturned inventory" />
      </Helmet>

      <Navbar />

      <main className="container mx-auto px-4 py-8 pt-24">
        <div className="flex flex-col gap-6">
          {/* Header */}
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
            <div>
              <h1 className="text-3xl font-bold">FBA Reimbursements</h1>
              <p className="text-muted-foreground mt-1">
                Track money owed to you by Amazon for lost, damaged, and unreturned inventory
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={exportToCSV} disabled={filteredReimbursements.length === 0}>
                <Download className="h-4 w-4 mr-2" />
                Export CSV
              </Button>
              <Button onClick={fetchReimbursements} disabled={loading}>
                <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
                Refresh
              </Button>
            </div>
          </div>

          {/* Date Filters */}
          <Card>
            <CardContent className="pt-6">
              <div className="flex flex-wrap items-center gap-4">
                <div className="flex items-center gap-2">
                  <Calendar className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium">Date Range:</span>
                </div>
                <Input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="w-40"
                />
                <span className="text-muted-foreground">to</span>
                <Input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  className="w-40"
                />
                <Button variant="secondary" onClick={fetchReimbursements} disabled={loading}>
                  Apply
                </Button>
                {lastUpdate && (
                  <span className="text-xs text-muted-foreground ml-auto">
                    Last updated: {formatDate(lastUpdate)}
                  </span>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Summary Cards */}
          {summary && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <Card className="border-yellow-500/30 bg-yellow-500/5">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-yellow-500 flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4" />
                    Estimated Pending
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold text-yellow-400">
                    ${summary.totalPending.toFixed(2)}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Potential reimbursements to claim
                  </p>
                </CardContent>
              </Card>

              <Card className="border-green-500/30 bg-green-500/5">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-green-500 flex items-center gap-2">
                    <DollarSign className="h-4 w-4" />
                    Already Reimbursed
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold text-green-400">
                    ${summary.totalReimbursed.toFixed(2)}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Credits received from Amazon
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <Package className="h-4 w-4" />
                    Lost & Damaged
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">
                    ${(summary.warehouseLost.amount + summary.warehouseDamaged.amount).toFixed(2)}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    {summary.warehouseLost.count + summary.warehouseDamaged.count} items
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <RefreshCw className="h-4 w-4" />
                    Refunds Not Returned
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">
                    ${summary.refundNotReturned.amount.toFixed(2)}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    {summary.refundNotReturned.count} items (45+ days)
                  </p>
                </CardContent>
              </Card>
            </div>
          )}

          {/* Info Box */}
          <Card className="bg-blue-500/5 border-blue-500/30">
            <CardContent className="pt-4">
              <div className="flex items-start gap-3">
                <Info className="h-5 w-5 text-blue-400 mt-0.5 flex-shrink-0" />
                <div className="text-sm">
                  <p className="font-medium text-blue-400 mb-1">How Reimbursements Work</p>
                  <ul className="list-disc list-inside text-muted-foreground space-y-1">
                    <li><strong>Refunds Not Returned:</strong> When a customer is refunded but doesn't return the product within 45 days, Amazon should reimburse you.</li>
                    <li><strong>Lost & Damaged:</strong> When Amazon loses or damages your inventory in their warehouse, you're entitled to reimbursement.</li>
                    <li>Review items marked as "Eligible" and open cases with Seller Support to claim your money.</li>
                    <li>These are estimates - Amazon may reimburse different amounts or deny claims.</li>
                  </ul>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Tabs & Table */}
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <div className="flex items-center justify-between flex-wrap gap-4 mb-2">
              <TabsList>
                <TabsTrigger value="all">All ({reimbursements.length})</TabsTrigger>
                <TabsTrigger value="returns">
                  Returns ({reimbursements.filter(r => r.type === 'REFUND_NOT_RETURNED').length})
                </TabsTrigger>
                <TabsTrigger value="lost">
                  Lost ({reimbursements.filter(r => r.type === 'WAREHOUSE_LOST').length})
                </TabsTrigger>
                <TabsTrigger value="damaged">
                  Damaged ({reimbursements.filter(r => r.type === 'WAREHOUSE_DAMAGED').length})
                </TabsTrigger>
                <TabsTrigger value="other">
                  Other ({reimbursements.filter(r => !['REFUND_NOT_RETURNED', 'WAREHOUSE_LOST', 'WAREHOUSE_DAMAGED'].includes(r.type)).length})
                </TabsTrigger>
              </TabsList>
              <div className="flex items-center gap-2">
                <Checkbox 
                  id="eligible-filter" 
                  checked={showOnlyEligible}
                  onCheckedChange={(checked) => setShowOnlyEligible(checked === true)}
                />
                <Label htmlFor="eligible-filter" className="text-sm cursor-pointer">
                  Show only eligible items
                </Label>
              </div>
            </div>

            <TabsContent value={activeTab} className="mt-4">
              <Card>
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Product</TableHead>
                          <TableHead 
                            className="cursor-pointer hover:bg-muted/50 select-none"
                            onClick={() => handleSort('type')}
                          >
                            <div className="flex items-center">
                              Type
                              {getSortIcon('type')}
                            </div>
                          </TableHead>
                          <TableHead 
                            className="cursor-pointer hover:bg-muted/50 select-none"
                            onClick={() => handleSort('status')}
                          >
                            <div className="flex items-center">
                              Status
                              {getSortIcon('status')}
                            </div>
                          </TableHead>
                          <TableHead className="text-right">Qty</TableHead>
                          <TableHead 
                            className="text-right cursor-pointer hover:bg-muted/50 select-none"
                            onClick={() => handleSort('amount')}
                          >
                            <div className="flex items-center justify-end">
                              Amount
                              {getSortIcon('amount')}
                            </div>
                          </TableHead>
                          <TableHead 
                            className="cursor-pointer hover:bg-muted/50 select-none"
                            onClick={() => handleSort('date')}
                          >
                            <div className="flex items-center">
                              Date
                              {getSortIcon('date')}
                            </div>
                          </TableHead>
                          <TableHead>Days Open</TableHead>
                          <TableHead>Order ID</TableHead>
                          <TableHead>Reimbursement ID</TableHead>
                          <TableHead className="text-center">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {filteredReimbursements.length === 0 && !loading ? (
                          <TableRow>
                            <TableCell colSpan={10} className="text-center py-8 text-muted-foreground">
                              No reimbursement items found for this date range
                            </TableCell>
                          </TableRow>
                        ) : filteredReimbursements.length === 0 && loading ? (
                          <TableRow>
                            <TableCell colSpan={10} className="text-center py-8">
                              <RefreshCw className="h-6 w-6 animate-spin mx-auto mb-2" />
                              Loading reimbursements...
                            </TableCell>
                          </TableRow>
                        ) : (
                          filteredReimbursements.map((item) => (
                            <TableRow key={item.id}>
                              <TableCell>
                                <div className="flex items-center gap-3">
                                  {item.imageUrl ? (
                                    <img 
                                      src={item.imageUrl} 
                                      alt={item.title || item.asin}
                                      className="w-10 h-10 object-contain rounded border"
                                    />
                                  ) : (
                                    <div className="w-10 h-10 bg-muted rounded flex items-center justify-center">
                                      <Package className="h-4 w-4 text-muted-foreground" />
                                    </div>
                                  )}
                                  <div>
                                    <div className="font-medium text-sm line-clamp-1">
                                      {item.title || 'Unknown Product'}
                                    </div>
                                    <div className="text-xs text-muted-foreground flex items-center gap-2">
                                      <a 
                                        href={`https://amazon.com/dp/${item.asin}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-blue-400 hover:underline flex items-center gap-1"
                                      >
                                        {item.asin}
                                        <ExternalLink className="h-3 w-3" />
                                      </a>
                                      {item.sku && <span>• {item.sku}</span>}
                                    </div>
                                  </div>
                                </div>
                              </TableCell>
                              <TableCell>
                                <span className="text-sm">{getTypeLabel(item.type)}</span>
                              </TableCell>
                              <TableCell>
                                {getStatusBadge(item.status)}
                              </TableCell>
                              <TableCell className="text-right">{item.quantity}</TableCell>
                              <TableCell className="text-right font-medium">
                                ${item.amountUSD.toFixed(2)}
                              </TableCell>
                              <TableCell className="text-sm">
                                {formatDate(item.postedDate)}
                              </TableCell>
                              <TableCell>
                                {item.daysOpen !== undefined ? (
                                  <span className={item.daysOpen >= 45 ? 'text-green-400' : 'text-muted-foreground'}>
                                    {item.daysOpen} days
                                  </span>
                                ) : '-'}
                              </TableCell>
                              <TableCell className="text-xs font-mono">
                                {item.orderId ? (
                                  <a
                                    href={`https://sellercentral.amazon.com/orders-v3/order/${item.orderId}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-blue-400 hover:text-blue-300 hover:underline inline-flex items-center gap-1"
                                    title="Open this order in Amazon Seller Central"
                                  >
                                    {item.orderId}
                                    <ExternalLink className="h-3 w-3" />
                                  </a>
                                ) : '-'}
                              </TableCell>
                              <TableCell className="text-xs font-mono">
                                {item.reimbursementId ? (
                                  item.caseId ? (
                                    <a
                                      href={`https://sellercentral.amazon.com/cu/case-dashboard/view-case?caseID=${item.caseId}`}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="text-blue-400 hover:text-blue-300 hover:underline inline-flex items-center gap-1"
                                      title={`Case ${item.caseId} — open in Seller Central`}
                                    >
                                      {item.reimbursementId}
                                      <ExternalLink className="h-3 w-3" />
                                    </a>
                                  ) : (
                                    <span title="Reimbursement ID (no linked case)">{item.reimbursementId}</span>
                                  )
                                ) : (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 px-2 text-xs"
                                    onClick={() => lookupReimbursementId(item)}
                                    disabled={!!lookupLoading[item.id] || (!item.orderId && !item.sku)}
                                    title="Query Amazon for the reimbursement ID"
                                  >
                                    {lookupLoading[item.id] ? (
                                      <RefreshCw className="h-3 w-3 animate-spin" />
                                    ) : (
                                      'Lookup'
                                    )}
                                  </Button>
                                )}
                              </TableCell>
                              <TableCell className="text-center">
                                {item.type === 'REFUND_NOT_RETURNED' && item.orderId ? (
                                  <div className="flex items-center gap-1 justify-center">
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => copyClaimDetails(item)}
                                      className="h-8 px-2"
                                      title="Copy claim details for Seller Central"
                                    >
                                      <Copy className="h-4 w-4 mr-1" />
                                      Copy
                                    </Button>
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      asChild
                                      className="h-8 px-2"
                                      title="Open Amazon Seller Central to request reimbursement"
                                    >
                                      <a
                                        href="https://sellercentral.amazon.com/help/hub/support/describe?issueId=FBA_RETURNS"
                                        target="_blank"
                                        rel="noopener noreferrer"
                                      >
                                        <ExternalLink className="h-4 w-4 mr-1" />
                                        Claim
                                      </a>
                                    </Button>
                                  </div>
                                ) : (
                                  <span className="text-muted-foreground">-</span>
                                )}
                              </TableCell>
                            </TableRow>
                          ))
                        )}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>

          {/* Help Section */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">How to Claim Reimbursements</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid md:grid-cols-2 gap-6">
                <div>
                  <h3 className="font-medium mb-2">For Lost & Damaged Inventory:</h3>
                  <ol className="list-decimal list-inside text-sm text-muted-foreground space-y-1">
                    <li>Go to Seller Central → Help → Contact Us</li>
                    <li>Select "Fulfillment by Amazon" → "Inventory Damaged or Lost in Warehouse"</li>
                    <li>Choose "Investigate Inventory Lost in FBA Warehouse" or "Investigate Inventory Damaged"</li>
                    <li>Provide the FNSKU/ASIN and date range</li>
                    <li>Amazon will investigate and reimburse if valid</li>
                  </ol>
                </div>
                <div>
                  <h3 className="font-medium mb-2">For Refunds Not Returned (45+ days):</h3>
                  <ol className="list-decimal list-inside text-sm text-muted-foreground space-y-1">
                    <li>Wait at least 45 days after the refund was issued</li>
                    <li>Go to Seller Central → Help → Contact Us</li>
                    <li>Select "Customers and Orders" → "Customer Feedback or Refund Issue"</li>
                    <li>Explain the customer was refunded but did not return the item</li>
                    <li>Provide the Order ID and refund date</li>
                  </ol>
                </div>
              </div>
              <div className="flex items-center gap-4 pt-2">
                <a 
                  href="https://sellercentral.amazon.com/help/hub/reference/G200213130"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-blue-400 hover:underline flex items-center gap-1"
                >
                  Amazon FBA Reimbursement Policy
                  <ExternalLink className="h-3 w-3" />
                </a>
                <a 
                  href="https://sellercentral.amazon.com/cu/case-lobby"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-blue-400 hover:underline flex items-center gap-1"
                >
                  Open Seller Support Case
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
};

export default Reimbursements;
