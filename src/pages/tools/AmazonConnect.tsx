import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { useSubscription } from '@/hooks/use-subscription';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CheckCircle2, AlertCircle, ExternalLink, Shield, Loader2, XCircle, Package, DollarSign, History } from 'lucide-react';
import { toast } from 'sonner';
import { Progress } from '@/components/ui/progress';
import Navbar from '@/components/Navbar';

interface SellerAuth {
  id: string;
  seller_id: string;
  marketplace_id: string;
  selling_partner_id: string;
  created_at: string;
}

const MARKETPLACE_LABELS: Record<string, string> = {
  ATVPDKIKX0DER: 'United States',
  A2EUQ1WTGCTBG2: 'Canada',
  A1AM78C64UM0Y8: 'Mexico',
  A2Q3Y263D00KWC: 'Brazil',
  A1F83G8C2ARO7P: 'United Kingdom',
  A1PA6795UKMFR9: 'Germany',
  A13V1IB3VIYZZH: 'France',
  APJ6JRA9NG5V4: 'Italy',
  A1RKKUPIHCS9HS: 'Spain',
  A1805IZSGTT6HS: 'Netherlands',
  A2NODRKZP88ZB9: 'Sweden',
  A1C3SOZRARQ6R3: 'Poland',
  AMEN7PMS3EDWL: 'Belgium',
  A33AVAJ2PDY3EV: 'Turkey',
  A17E79C6D8DWNP: 'Saudi Arabia',
  A2VIGQ35RCS4UG: 'United Arab Emirates',
  ARBP9OOSHTCHU: 'Egypt',
  A1VC38T7YXB528: 'Japan',
  A39IBJ37TRP1C6: 'Australia',
  A21TJRUUN4KGV: 'India',
};

const MARKETPLACE_OPTIONS = [
  { id: 'ATVPDKIKX0DER', name: 'United States', authUrl: 'https://sellercentral.amazon.com/apps/authorize/consent' },
  { id: 'A2EUQ1WTGCTBG2', name: 'Canada', authUrl: 'https://sellercentral.amazon.ca/apps/authorize/consent' },
  { id: 'A1AM78C64UM0Y8', name: 'Mexico', authUrl: 'https://sellercentral.amazon.com.mx/apps/authorize/consent' },
  { id: 'A2Q3Y263D00KWC', name: 'Brazil', authUrl: 'https://sellercentral.amazon.com.br/apps/authorize/consent' },
  { id: 'A1F83G8C2ARO7P', name: 'United Kingdom', authUrl: 'https://sellercentral.amazon.co.uk/apps/authorize/consent' },
  { id: 'A1PA6795UKMFR9', name: 'Germany', authUrl: 'https://sellercentral.amazon.de/apps/authorize/consent' },
  { id: 'A13V1IB3VIYZZH', name: 'France', authUrl: 'https://sellercentral.amazon.fr/apps/authorize/consent' },
  { id: 'APJ6JRA9NG5V4', name: 'Italy', authUrl: 'https://sellercentral.amazon.it/apps/authorize/consent' },
  { id: 'A1RKKUPIHCS9HS', name: 'Spain', authUrl: 'https://sellercentral.amazon.es/apps/authorize/consent' },
  { id: 'A1805IZSGTT6HS', name: 'Netherlands', authUrl: 'https://sellercentral.amazon.nl/apps/authorize/consent' },
  { id: 'A2NODRKZP88ZB9', name: 'Sweden', authUrl: 'https://sellercentral.amazon.se/apps/authorize/consent' },
  { id: 'A1C3SOZRARQ6R3', name: 'Poland', authUrl: 'https://sellercentral.amazon.pl/apps/authorize/consent' },
  { id: 'AMEN7PMS3EDWL', name: 'Belgium', authUrl: 'https://sellercentral.amazon.com.be/apps/authorize/consent' },
  { id: 'A39IBJ37TRP1C6', name: 'Australia', authUrl: 'https://sellercentral.amazon.com.au/apps/authorize/consent' },
  { id: 'A1VC38T7YXB528', name: 'Japan', authUrl: 'https://sellercentral.amazon.co.jp/apps/authorize/consent' },
  { id: 'A21TJRUUN4KGV', name: 'India', authUrl: 'https://sellercentral.amazon.in/apps/authorize/consent' },
];

export default function AmazonConnect() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { subscription, loading: subLoading } = useSubscription();
  const [authorizations, setAuthorizations] = useState<SellerAuth[]>([]);
  const [loading, setLoading] = useState(true);
  const [stripeSubscribed, setStripeSubscribed] = useState<boolean | null>(null);
  
  // Background sync status from database
  const [backgroundSyncStatus, setBackgroundSyncStatus] = useState<{
    inProgress: boolean;
    progress: string | null;
    startedAt: string | null;
  }>({ inProgress: false, progress: null, startedAt: null });
  
  // Local sync progress for immediate UI feedback
  const [localSyncStep, setLocalSyncStep] = useState<string | null>(null);
  const [localSyncProgress, setLocalSyncProgress] = useState(0);
  const [syncJustStarted, setSyncJustStarted] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [isStoppingSync, setIsStoppingSync] = useState(false);
  const [selectedMarketplaceId, setSelectedMarketplaceId] = useState('ATVPDKIKX0DER');
  const cancelRequestedRef = useRef(false);
  const activeProgressIdRef = useRef<string | null>(null);

  const resetLocalSyncState = () => {
    setLocalSyncStep(null);
    setLocalSyncProgress(0);
    setSyncJustStarted(false);
  };

  const stopPostConnectSync = async () => {
    if (!user || isStoppingSync) return;

    setIsStoppingSync(true);
    cancelRequestedRef.current = true;

    try {
      if (activeProgressIdRef.current) {
        await supabase
          .from('pl_sync_progress')
          .update({
            status: 'cancelled',
            message: 'Sync stopped by user.',
            updated_at: new Date().toISOString(),
          })
          .eq('id', activeProgressIdRef.current);
      }

      await supabase
        .from('user_sync_status')
        .upsert({
          user_id: user.id,
          history_syncing: false,
          last_error: 'Post-connect sync stopped by user.',
        }, { onConflict: 'user_id' });

      // Clear the historical sync flag in sales_sync_state — this is the
      // source of truth that the polling loop reads. Without this, the
      // banner re-appears on the next poll tick.
      await supabase
        .from('sales_sync_state')
        .upsert({
          user_id: user.id,
          historical_sync_in_progress: false,
          historical_sync_progress: 'Sync stopped by user.',
        }, { onConflict: 'user_id' });

      setBackgroundSyncStatus((prev) => ({
        ...prev,
        inProgress: false,
        progress: 'Sync stopped.',
      }));
      resetLocalSyncState();
      toast.success('Sync stopped. You can restart later when you want.');
    } catch (error) {
      console.error('Failed to stop post-connect sync:', error);
      toast.error('Failed to stop sync. Please try again.');
      cancelRequestedRef.current = false;
    } finally {
      setIsStoppingSync(false);
    }
  };

  useEffect(() => {
    if (!user) { setIsAdmin(false); return; }
    supabase.from('user_roles').select('role').eq('user_id', user.id).eq('role', 'admin').maybeSingle()
      .then(({ data }) => setIsAdmin(!!data));
  }, [user]);

  // Check Stripe subscription status
  useEffect(() => {
    const checkStripe = async () => {
      try {
        const { data, error } = await supabase.functions.invoke('check-subscription', {});
        if (!error && data) {
          setStripeSubscribed(data.subscribed === true);
        }
      } catch (err) {
        console.error('Failed to check Stripe subscription:', err);
      }
    };
    if (user) checkStripe();
  }, [user]);

  // Amazon SP-API OAuth configuration. The application_id is fetched from the
  // backend (get-amazon-app-id) so it always matches the LWA client_id/secret
  // used during the token-exchange step. Hardcoding it caused invalid_grant.
  const redirectUri = 'https://mstibdszibcheodvnprm.supabase.co/functions/v1/amazon-oauth-callback';

  // Check if user has existing data (to determine if they're new)
  const checkIfNewUser = async () => {
    if (!user) return true;
    
    const { count } = await supabase
      .from('sales_orders')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user.id);
    
    return (count || 0) < 10; // Consider "new" if less than 10 sales
  };

  // Check background sync status from database
  const checkSyncStatus = async () => {
    if (!user) return;
    
    const { data, error } = await supabase
      .from('sales_sync_state')
      .select('historical_sync_in_progress, historical_sync_progress, historical_sync_started_at')
      .eq('user_id', user.id)
      .maybeSingle();
    
    if (!error && data) {
      setBackgroundSyncStatus({
        inProgress: data.historical_sync_in_progress || false,
        progress: data.historical_sync_progress,
        startedAt: data.historical_sync_started_at
      });
    }
  };

  // Poll for sync status when a sync is in progress
  useEffect(() => {
    if (!user) return;
    
    // Initial check
    checkSyncStatus();
    
    // Poll every 5 seconds if sync is in progress
    const interval = setInterval(() => {
      checkSyncStatus();
    }, 5000);
    
    return () => clearInterval(interval);
  }, [user]);

  // Auto-start full sync in background (no user interaction required)
  const startAutoFullSync = async () => {
    try {
      cancelRequestedRef.current = false;
      activeProgressIdRef.current = null;
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        console.error('No session found for auto sync');
        return;
      }

      console.log('Starting automatic full sync after Amazon connection...');
      setLocalSyncStep('Starting automatic sync...');
      setLocalSyncProgress(5);

      // Mark amazon_connected and inventory sync started
      await supabase.from('user_sync_status').upsert({
        user_id: user!.id,
        amazon_connected: true,
        inventory_sync_started_at: new Date().toISOString(),
      }, { onConflict: 'user_id' });

      // ===== PHASE 1: IMMEDIATE READINESS =====

      // Step 1: Full inventory sync (report-based) — THIS IS THE KEY FIX
      setLocalSyncStep('Syncing full inventory catalog from Amazon...');
      setLocalSyncProgress(10);
      console.log('Auto-sync: Starting full inventory sync (sync-inventory-report)...');
      const { data: invReportData, error: invReportError } = await supabase.functions.invoke('sync-inventory-report', {
        headers: { Authorization: `Bearer ${session.access_token}` },
        body: { user_id: user!.id },
      });

      activeProgressIdRef.current = invReportData?.progressId ?? null;

      if (invReportError) {
        console.error('Auto-sync inventory report error:', invReportError);
        await supabase.from('user_sync_status').upsert({
          user_id: user!.id,
          last_error: `Inventory sync failed: ${invReportError.message}`,
        }, { onConflict: 'user_id' });
      } else {
        console.log('Auto-sync inventory report started:', invReportData);

        // Poll for inventory sync completion (max 10 minutes)
        if (invReportData?.progressId) {
          let syncComplete = false;
          let pollCount = 0;
          const maxPolls = 120;

          while (!syncComplete && pollCount < maxPolls) {
            await new Promise(resolve => setTimeout(resolve, 5000));
            pollCount++;

            if (cancelRequestedRef.current) {
              setLocalSyncStep('Sync stopped.');
              setLocalSyncProgress(0);
              return;
            }

            const progressPct = Math.min(10 + Math.floor((pollCount / maxPolls) * 30), 40);
            setLocalSyncProgress(progressPct);
            setLocalSyncStep(`Syncing inventory catalog... (${Math.floor(pollCount * 5 / 60)}m elapsed)`);

            const { data: progress } = await supabase
              .from('pl_sync_progress')
              .select('status')
              .eq('id', invReportData.progressId)
              .single();

            if (progress?.status === 'cancelled') {
              setLocalSyncStep('Sync stopped.');
              setLocalSyncProgress(0);
              return;
            }

            if (progress?.status === 'completed' || progress?.status === 'complete') {
              console.log('✅ Full inventory sync completed');
              syncComplete = true;
            } else if (progress?.status === 'error') {
              console.error('❌ Inventory sync errored');
              syncComplete = true;
            }
          }

          if (syncComplete) {
            await supabase.from('user_sync_status').upsert({
              user_id: user!.id,
              inventory_synced: true,
              inventory_sync_completed_at: new Date().toISOString(),
            }, { onConflict: 'user_id' });
          }
        }
      }

      if (cancelRequestedRef.current) return;

      // Step 2: FNSKU mapping
      setLocalSyncStep('Mapping FNSKU labels...');
      setLocalSyncProgress(45);
      console.log('Auto-sync: Starting FNSKU sync...');
      const { data: fnskuData, error: fnskuError } = await supabase.functions.invoke('sync-fnsku-report', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });

      if (fnskuError) {
        console.error('Auto-sync FNSKU error:', fnskuError);
      } else {
        console.log('Auto-sync FNSKU started:', fnskuData);
        await supabase.from('user_sync_status').upsert({
          user_id: user!.id,
          fnsku_mapped: true,
        }, { onConflict: 'user_id' });
      }

      if (cancelRequestedRef.current) return;

      // Step 3: Auto-create repricer assignments for eligible SKUs
      setLocalSyncStep('Creating repricer assignments for eligible listings...');
      setLocalSyncProgress(50);
      console.log('Auto-sync: Starting bulk auto-assign...');
      const { data: assignData, error: assignError } = await supabase.functions.invoke('auto-assign-bulk', {
        headers: { Authorization: `Bearer ${session.access_token}` },
        body: { marketplace: 'US' },
      });

      if (assignError) {
        console.error('Auto-assign error:', assignError);
      } else {
        console.log('Auto-assign result:', assignData);
        const created = assignData?.created || 0;
        const skipped = assignData?.skipped || 0;
        if (created > 0) {
          toast.success(`Repricer: ${created} assignments created, ${skipped} skipped`, { duration: 8000 });
        } else if (skipped > 0) {
          toast.info(`Repricer: ${skipped} listings skipped (missing cost or inactive)`, { duration: 6000 });
        }
      }

      // ===== PHASE 2: BACKGROUND HISTORICAL SYNC =====
      await supabase.from('user_sync_status').upsert({
        user_id: user!.id,
        history_syncing: true,
      }, { onConflict: 'user_id' });

      if (cancelRequestedRef.current) return;

      // Step 3: 2-year sales history (background)
      setLocalSyncStep('Syncing 2 years of sales history (background)...');
      setLocalSyncProgress(55);
      const endDate = new Date();
      const startDate = new Date();
      startDate.setFullYear(startDate.getFullYear() - 2);
      const formatDate = (d: Date) => d.toISOString().split('T')[0];

      console.log('Auto-sync: Starting 2-year sales history sync...');
      const { error: salesError } = await supabase.functions.invoke('sync-sales-orders', {
        headers: { Authorization: `Bearer ${session.access_token}` },
        body: {
          sync_history: true,
          start_date: formatDate(startDate),
          end_date: formatDate(endDate),
        },
      });

      if (salesError) {
        console.error('Auto-sync sales error:', salesError);
      } else {
        await supabase.from('user_sync_status').upsert({
          user_id: user!.id,
          recent_sales_synced: true,
        }, { onConflict: 'user_id' });
      }

      if (cancelRequestedRef.current) return;

      // Step 4: 2-year refunds (background)
      setLocalSyncStep('Syncing refund history (background)...');
      setLocalSyncProgress(75);
      console.log('Auto-sync: Starting refund sync...');
      const { error: refundError } = await supabase.functions.invoke('sync-sales-orders', {
        headers: { Authorization: `Bearer ${session.access_token}` },
        body: { sync_all_refunds_historical: true },
      });

      if (refundError) {
        console.error('Auto-sync refunds error:', refundError);
      }

      setLocalSyncStep('Sync initiated! Processing in background...');
      setLocalSyncProgress(100);
      setSyncJustStarted(true);

      // Keep showing progress for longer, then switch to background message
      setTimeout(() => {
        setLocalSyncStep('Processing your history in background...');
        setLocalSyncProgress(0);
      }, 5000);

      setTimeout(() => {
        checkSyncStatus();
        if (backgroundSyncStatus.inProgress) {
          setLocalSyncStep(null);
          setSyncJustStarted(false);
        }
      }, 15000);

    } catch (err: any) {
      console.error('Auto full sync error:', err);
      if (user) {
        await supabase.from('user_sync_status').upsert({
          user_id: user.id,
          last_error: `Sync error: ${err.message}`,
        }, { onConflict: 'user_id' });
      }
      setLocalSyncStep('Sync error. Will retry automatically.');
      setTimeout(() => {
        setLocalSyncStep(null);
        setLocalSyncProgress(0);
      }, 5000);
    } finally {
      activeProgressIdRef.current = null;
    }
  };

  // Exchange authorization code for refresh token (for direct Seller Central reauthorization)
  const exchangeCodeForToken = async (code: string, sellingPartnerId: string | null, stateParam: string | null) => {
    if (!user) return;
    
    try {
      toast.info('Exchanging authorization code for tokens...', { duration: 5000 });
      
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        toast.error('No active session. Please log in again.');
        return;
      }

      const { data, error } = await supabase.functions.invoke('exchange-amazon-code', {
        headers: { Authorization: `Bearer ${session.access_token}` },
        body: {
          code,
          selling_partner_id: sellingPartnerId,
          state: stateParam,
        },
      });

      if (error) {
        console.error('Code exchange error:', error);
        toast.error('Failed to exchange authorization code: ' + error.message);
        return;
      }

      if (data?.error) {
        console.error('Code exchange failed:', data);
        toast.error('Authorization failed: ' + (data.details || data.error));
        return;
      }

      toast.success('Amazon seller account connected successfully!');
      
      // Start auto sync
      startAutoFullSync();
      
      // Reload authorizations
      loadAuthorizations();
      
    } catch (err: any) {
      console.error('Code exchange error:', err);
      toast.error('Failed to connect Amazon account');
    }
  };

  useEffect(() => {
    // Check for checkout success from Stripe
    const checkout = searchParams.get('checkout');
    if (checkout === 'success') {
      setShowOnboarding(true);
      toast.success('Subscription started! Now connect your Amazon account to get started.', { duration: 8000 });
      // Clean up the checkout param
      const cleaned = new URLSearchParams(searchParams);
      cleaned.delete('checkout');
      const newSearch = cleaned.toString();
      navigate(`/tools/amazon-connect${newSearch ? `?${newSearch}` : ''}`, { replace: true });
    }

    // Check for success/error parameters from OAuth callback
    const success = searchParams.get('success');
    const error = searchParams.get('error');

    // Some Seller Central flows redirect to /amazon/connect first with a "callback" URL
    const amazonCallbackUri = searchParams.get('amazon_callback_uri');
    const amazonState = searchParams.get('amazon_state');
    const version = searchParams.get('version');
    const stateParam = searchParams.get('state');

    // Check for spapi_oauth_code (direct from Amazon redirect)
    const spapiCode = searchParams.get('spapi_oauth_code');
    const sellingPartnerId = searchParams.get('selling_partner_id');

    // 1) Intermediate hop: forward user to the real Seller Central confirm URL
    if (amazonCallbackUri) {
      try {
        const decoded = decodeURIComponent(amazonCallbackUri);
        const nextUrl = new URL(decoded);
        if (amazonState) nextUrl.searchParams.set('state', amazonState);
        if (version) nextUrl.searchParams.set('version', version);
        if (sellingPartnerId) nextUrl.searchParams.set('selling_partner_id', sellingPartnerId);

        console.log('Forwarding to Amazon consent confirm:', nextUrl.toString());
        window.location.href = nextUrl.toString();
        return;
      } catch (e) {
        console.error('Invalid amazon_callback_uri:', amazonCallbackUri, e);
      }
    }

    // 2) Final hop: we got the code, exchange for tokens
    if (spapiCode) {
      console.log('Detected spapi_oauth_code in URL, exchanging for tokens...');
      // Clear URL parameters immediately to prevent re-exchange on refresh
      window.history.replaceState({}, '', '/tools/amazon-connect');
      exchangeCodeForToken(spapiCode, sellingPartnerId, stateParam);
    } else if (success === 'true') {
      toast.success('Amazon seller account connected successfully!');

      // AUTOMATIC full sync - no dialog, no user action required
      if (user) {
        // Start full historical sync automatically in background
        startAutoFullSync();
      }

      // Clear URL parameters
      window.history.replaceState({}, '', '/tools/amazon-connect');
    } else if (error) {
      toast.error(`Authorization failed: ${error}`);
      window.history.replaceState({}, '', '/tools/amazon-connect');
    }
  
    // Load existing authorizations
    if (user) {
      loadAuthorizations();
    } else {
      setLoading(false);
    }
  }, [user, searchParams]);

  const loadAuthorizations = async () => {
    if (!user) return;

    try {
      setLoading(true);
      // Select only non-secret columns. access_token/refresh_token/mws_auth_token
      // are REVOKEd from anon/authenticated at the DB layer — edge functions
      // read them via service_role. Using select('*') would 42501 here.
      const { data, error } = await supabase
        .from('seller_authorizations')
        .select('id, user_id, seller_id, marketplace_id, selling_partner_id, created_at, updated_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });

      if (error) throw error;
      setAuthorizations(data || []);
    } catch (error) {
      console.error('Error loading authorizations:', error);
      toast.error('Failed to load connected accounts');
    } finally {
      setLoading(false);
    }
  };

  const startInitialSync = async () => {
    try {
      console.log('Starting initial FNSKU/inventory sync after Amazon connect');
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        console.error('No session found when starting initial sync');
        return;
      }

      toast.info('Starting initial inventory sync from Amazon...', { duration: 5000 });

      const { data, error } = await supabase.functions.invoke('sync-fnsku-report', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });

      const payload = data as any;
      if (payload?.error === 'sync_in_progress' || payload?.error === 'sync_cooldown') {
        toast.error(payload.message || 'Amazon inventory sync is temporarily unavailable. Please try again later.', { duration: 8000 });
        return;
      }

      if (error) {
        console.error('Error starting initial sync:', error);
        toast.error(error.message || 'Failed to start initial inventory sync');
        return;
      }

      toast.success((data as any)?.message || 'Inventory sync started in the background.', { duration: 6000 });
    } catch (err: any) {
      console.error('Unexpected error starting initial sync:', err);
      toast.error('Failed to start initial inventory sync');
    }
  };



  const handleConnect = async () => {
    if (!user) {
      toast.error('Please log in first');
      navigate('/login');
      return;
    }

    // Admins bypass subscription check
    if (!isAdmin) {
      const hasLocalSub = subscription && ['active', 'trialing', 'past_due'].includes(subscription.status);
      if (!hasLocalSub && !stripeSubscribed) {
        toast.error('Active subscription required', {
          description: 'Please subscribe to a plan before connecting your Amazon account.',
          duration: 6000,
        });
        navigate('/subscriptions');
        return;
      }
    }

    // Fetch the SP-API application_id from the backend so it always matches
    // the LWA client_id/secret used during the token-exchange step. This
    // prevents the invalid_grant error caused by app-identity mismatch.
    let applicationId: string | null = null;
    try {
      const { data, error } = await supabase.functions.invoke('get-amazon-app-id');
      if (error) throw error;
      applicationId = (data as any)?.application_id || null;
      if (!applicationId) {
        toast.error('Amazon OAuth is not configured', {
          description: 'Server is missing SPAPI_LWA_APP_ID. Please contact support.',
          duration: 8000,
        });
        return;
      }
      console.log('Amazon OAuth start debug:', {
        applicationIdPrefix: applicationId.substring(0, 24),
        clientIdPrefix: (data as any)?.client_id_prefix,
        redirectUri,
      });
    } catch (err) {
      console.error('Failed to fetch Amazon application_id:', err);
      toast.error('Failed to start Amazon authorization. Please try again.');
      return;
    }

    // Mint a server-side nonce for the OAuth state. The callback validates it
    // against amazon_oauth_states, so a forged callback cannot bind the auth
    // to another user or redirect to an untrusted origin.
    let state: string;
    try {
      const { data, error } = await supabase.functions.invoke('amazon-oauth-start', {
        body: { marketplace_id: selectedMarketplaceId, origin: window.location.origin },
      });
      if (error) {
        console.error('amazon-oauth-start invoke error:', error);
        throw error;
      }
      if (!(data as any)?.state) {
        console.error('amazon-oauth-start returned no state:', data);
        throw new Error((data as any)?.error || 'Missing state');
      }
      state = (data as any).state as string;
    } catch (err: any) {
      console.error('Failed to mint OAuth state:', err);
      toast.error('Failed to start Amazon authorization', {
        description: err?.message || 'Please sign out and back in, then try again.',
        duration: 8000,
      });
      return;
    }

    const selectedMarketplace = MARKETPLACE_OPTIONS.find((option) => option.id === selectedMarketplaceId) || MARKETPLACE_OPTIONS[0];

    // Build Amazon authorization URL
    const authUrl = new URL(selectedMarketplace.authUrl);
    authUrl.searchParams.set('application_id', applicationId);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('version', 'beta');

    console.log('Redirecting to Amazon authorization:', authUrl.toString());

    // Redirect to Amazon authorization page
    window.location.href = authUrl.toString();
  };

  const handleDisconnect = async (authId: string, sellerId: string) => {
    if (!confirm(`Are you sure you want to disconnect seller account ${sellerId}?`)) {
      return;
    }

    try {
      const { error } = await supabase
        .from('seller_authorizations')
        .delete()
        .eq('id', authId);

      if (error) throw error;

      toast.success('Amazon seller account disconnected');
      loadAuthorizations();
    } catch (error) {
      console.error('Error disconnecting account:', error);
      toast.error('Failed to disconnect account');
    }
  };

  if (!user) {
    return (
      <>
        <Navbar />
        <div className="container mx-auto py-8 px-4 max-w-4xl">
          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              Please log in to connect your Amazon seller account.
            </AlertDescription>
          </Alert>
          <Button onClick={() => navigate('/login')} className="mt-4">
            Go to Login
          </Button>
        </div>
      </>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-[hsl(222,84%,4.9%)] via-[hsl(230,50%,10%)] to-[hsl(260,50%,8%)]">
      {/* Animated gradient orbs */}
      <div className="fixed top-1/4 -left-32 w-96 h-96 bg-primary/20 rounded-full blur-[120px] animate-pulse pointer-events-none" />
      <div className="fixed bottom-1/4 -right-32 w-96 h-96 bg-purple-500/15 rounded-full blur-[120px] animate-pulse pointer-events-none" style={{ animationDelay: '1s' }} />
      <div className="fixed inset-0 bg-[linear-gradient(rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:64px_64px] pointer-events-none" />

      <Navbar />
      <div className="container mx-auto py-8 px-4 max-w-4xl pt-24 relative z-10">
      {/* Page Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-extrabold mb-2 text-white">Connect to Amazon</h1>
        {isAdmin && (
          <p className="text-gray-400">
            Connect your Amazon Seller Central account to access SP-API data including orders, inventory, financial reports, and product information.
          </p>
        )}
      </div>

      {/* Post-payment onboarding banner */}
      {(showOnboarding || (authorizations.length === 0 && !loading)) && (
        <Card className="mb-6 border-green-500/40 bg-green-500/10 backdrop-blur-sm">
          <CardContent className="p-6">
            <div className="flex items-start gap-4">
              <div className="bg-green-500/15 rounded-xl p-3 flex-shrink-0">
                <CheckCircle2 className="h-8 w-8 text-green-400" />
              </div>
              <div className="flex-1">
                <h3 className="text-lg font-bold text-white mb-1">
                  {showOnboarding ? '✅ Subscription Active — One More Step!' : 'Get Started'}
                </h3>
                <p className="text-sm text-gray-300 mb-3">
                  Connect your Amazon Seller Central account to unlock your dashboard, inventory sync, repricer, and sales tracking.
                </p>
                <div className="flex items-center gap-6 text-xs text-gray-400">
                  <span className="flex items-center gap-1.5">
                    <span className="w-5 h-5 rounded-full bg-green-500 text-white flex items-center justify-center text-[10px] font-bold">✓</span>
                    Account created
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="w-5 h-5 rounded-full bg-green-500 text-white flex items-center justify-center text-[10px] font-bold">✓</span>
                    Subscription active
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="w-5 h-5 rounded-full bg-blue-500 text-white flex items-center justify-center text-[10px] font-bold animate-pulse">3</span>
                    <span className="font-semibold text-white">Connect Amazon</span>
                  </span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {isAdmin && (
      <Card className="mb-6 bg-white/60 backdrop-blur-sm border-white/20">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-[hsl(221,90%,22%)] font-extrabold">
            <Shield className="h-5 w-5 text-primary" />
            What Data You Can Access
          </CardTitle>
          <CardDescription className="text-[hsl(221,90%,22%)]/70">
            Once authorized, you'll be able to retrieve the following data from your Amazon seller account:
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-3">
            <li className="flex items-start gap-3">
              <CheckCircle2 className="h-5 w-5 text-green-600 mt-0.5 flex-shrink-0" />
              <div>
                <strong className="text-foreground">Orders & Sales Data</strong>
                <p className="text-sm text-muted-foreground">View your order history, fulfillment status, and sales metrics</p>
              </div>
            </li>
            <li className="flex items-start gap-3">
              <CheckCircle2 className="h-5 w-5 text-green-600 mt-0.5 flex-shrink-0" />
              <div>
                <strong className="text-foreground">Product Inventory</strong>
                <p className="text-sm text-muted-foreground">Access your FBA inventory levels, FNSKU mappings, and product listings</p>
              </div>
            </li>
            <li className="flex items-start gap-3">
              <CheckCircle2 className="h-5 w-5 text-green-600 mt-0.5 flex-shrink-0" />
              <div>
                <strong className="text-foreground">Financial Reports</strong>
                <p className="text-sm text-muted-foreground">Download settlement reports and payment data</p>
              </div>
            </li>
            <li className="flex items-start gap-3">
              <CheckCircle2 className="h-5 w-5 text-green-600 mt-0.5 flex-shrink-0" />
              <div>
                <strong className="text-foreground">Product Fees & Pricing</strong>
                <p className="text-sm text-muted-foreground">Calculate accurate FBA fees and retrieve product pricing information</p>
              </div>
            </li>
          </ul>
        </CardContent>
      </Card>
      )}

      {/* Connection Status Card */}
      <Card className="bg-white/60 backdrop-blur-sm border-white/20">
        <CardHeader>
          <CardTitle className="text-[hsl(221,90%,22%)] font-extrabold">Connection Status</CardTitle>
          <CardDescription className="text-[hsl(221,90%,22%)]/70">
            Manage your connected Amazon seller accounts
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : authorizations.length > 0 ? (
            <div className="space-y-4">
              {authorizations.map((auth) => (
                <div
                  key={auth.id}
                  className="flex items-center justify-between p-4 border rounded-lg bg-card"
                >
                  <div className="flex items-center gap-3">
                    <CheckCircle2 className="h-5 w-5 text-green-600 flex-shrink-0" />
                    <div>
                      <p className="font-medium text-foreground">
                        Seller ID: {auth.seller_id}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        Marketplace: {MARKETPLACE_LABELS[auth.marketplace_id] || 'Unknown Marketplace'} ({auth.marketplace_id})
                      </p>
                      {auth.selling_partner_id && (
                        <p className="text-xs text-muted-foreground">
                          Selling Partner ID: {auth.selling_partner_id}
                        </p>
                      )}
                      <p className="text-xs text-muted-foreground mt-1">
                        Connected: {new Date(auth.created_at).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => handleDisconnect(auth.id, auth.seller_id)}
                  >
                    <XCircle className="h-4 w-4 mr-2" />
                    Disconnect
                  </Button>
                </div>
              ))}

              {/* Inline Sync Progress Banner */}
              {(localSyncStep || syncJustStarted || backgroundSyncStatus.inProgress || (backgroundSyncStatus.progress && backgroundSyncStatus.progress.startsWith('Complete'))) && (
                <div className={`p-4 rounded-lg border-2 ${
                  localSyncStep || syncJustStarted || backgroundSyncStatus.inProgress 
                    ? 'border-primary bg-primary/10' 
                    : 'border-green-500 bg-green-500/10'
                }`}>
                  <div className="flex items-start gap-3">
                    {localSyncStep || syncJustStarted || backgroundSyncStatus.inProgress ? (
                      <Loader2 className="h-5 w-5 animate-spin text-primary mt-0.5" />
                    ) : (
                      <CheckCircle2 className="h-5 w-5 text-green-600 mt-0.5" />
                    )}
                    <div className="flex-1 flex flex-col gap-2">
                      <span className={`font-semibold ${
                        localSyncStep || syncJustStarted || backgroundSyncStatus.inProgress 
                          ? 'text-primary' 
                          : 'text-green-600'
                      }`}>
                        {localSyncStep 
                          ? 'Syncing Your Amazon Data...' 
                          : syncJustStarted
                            ? 'Syncing Your Amazon Data...'
                            : backgroundSyncStatus.inProgress 
                            ? 'Historical sync in progress...' 
                              : 'Amazon connected successfully'}
                      </span>
                      <span className="text-sm text-muted-foreground">
                        {localSyncStep 
                          ? localSyncStep 
                          : syncJustStarted && !backgroundSyncStatus.progress 
                            ? 'Processing your 2-year history in background...' 
                            : backgroundSyncStatus.inProgress 
                              ? (backgroundSyncStatus.progress || 'Processing your data...')
                              : 'Your account is ready. Continue to set up your pricing.'}
                      </span>
                      {localSyncProgress > 0 && localSyncProgress < 100 && (
                        <Progress value={localSyncProgress} className="w-full h-2" />
                      )}
                      {backgroundSyncStatus.startedAt && backgroundSyncStatus.inProgress && !localSyncStep && (
                        <span className="text-xs text-muted-foreground">
                          Started: {new Date(backgroundSyncStatus.startedAt).toLocaleTimeString()}
                        </span>
                      )}
                      {(localSyncStep || syncJustStarted || backgroundSyncStatus.inProgress) && (
                        <div className="flex items-start justify-between gap-3 mt-2 p-3 bg-muted/50 rounded-lg">
                          <Package className="h-4 w-4 text-muted-foreground mt-0.5" />
                          <div className="flex-1 text-xs text-muted-foreground">
                            <p className="font-medium">Syncing: Inventory, 2 years of Sales & Refunds</p>
                            <p>This may take 30-60 minutes for high-volume accounts. You can leave this page.</p>
                          </div>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={stopPostConnectSync}
                            disabled={isStoppingSync}
                            className="shrink-0"
                          >
                            {isStoppingSync ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
                            <span className="ml-2">Stop sync</span>
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Connect Another Account Button - only show when not syncing */}
              {!localSyncStep && !syncJustStarted && !backgroundSyncStatus.inProgress && (
                <div className="pt-4 border-t">
                  <div className="mb-3 space-y-2">
                    <p className="text-sm font-medium text-foreground">Marketplace to connect</p>
                    <Select value={selectedMarketplaceId} onValueChange={setSelectedMarketplaceId}>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Select marketplace" />
                      </SelectTrigger>
                      <SelectContent>
                        {MARKETPLACE_OPTIONS.map((marketplace) => (
                          <SelectItem key={marketplace.id} value={marketplace.id}>
                            {marketplace.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button 
                    onClick={handleConnect} 
                    variant="outline" 
                    className="w-full"
                  >
                    <ExternalLink className="h-4 w-4 mr-2" />
                    Connect Another Amazon Account
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <div className="text-center py-12">
              <Shield className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
              <h3 className="text-lg font-semibold mb-2">No Connected Accounts</h3>
              <p className="text-muted-foreground mb-6 max-w-md mx-auto">
                Connect your Amazon seller account to start accessing your inventory data, orders, and financial reports via SP-API
              </p>
              <div className="max-w-md mx-auto mb-4 text-left">
                <p className="text-sm font-medium text-foreground mb-2">Marketplace to connect</p>
                <Select value={selectedMarketplaceId} onValueChange={setSelectedMarketplaceId}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select marketplace" />
                  </SelectTrigger>
                  <SelectContent>
                    {MARKETPLACE_OPTIONS.map((marketplace) => (
                      <SelectItem key={marketplace.id} value={marketplace.id}>
                        {marketplace.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button onClick={handleConnect} size="lg" className="gap-2">
                <ExternalLink className="h-4 w-4" />
                Connect Amazon Seller Account
              </Button>
              <p className="text-xs text-muted-foreground mt-4">
                You'll be securely redirected to Amazon to authorize access
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Security Notice */}
      <Alert className="mt-6 bg-white/60 backdrop-blur-sm border-white/20">
        <Shield className="h-4 w-4" />
        <AlertDescription className="text-[hsl(221,90%,22%)]">
          <strong>Secure & Private:</strong> This authorization uses Amazon's official OAuth 2.0 protocol. 
          Your Amazon credentials are never stored on our servers. You can revoke access at any time from 
          your Amazon Seller Central account settings or by disconnecting here.
        </AlertDescription>
      </Alert>

      </div>
    </div>
  );
}
