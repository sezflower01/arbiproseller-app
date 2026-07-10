import React, { createContext, useContext, useEffect, useState } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

interface AuthContextType {
  user: User | null;
  session: Session | null;
  emailVerified: boolean;
  loading: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const checkAccountStatus = async (userId: string): Promise<boolean> => {
  try {
    const { data } = await supabase
      .from('profiles')
      .select('account_status')
      .eq('id', userId)
      .maybeSingle();

    if (data?.account_status === 'suspended' || data?.account_status === 'deleted') {
      toast.error(
        data.account_status === 'suspended'
          ? 'Your account has been suspended. Please contact support.'
          : 'Your account has been deleted. Please sign up again to continue.'
      );
      await supabase.auth.signOut();
      return false;
    }
    return true;
  } catch {
    return true; // Allow login if check fails (profile may not exist yet)
  }
};

// Module-level flag: only true while a user-initiated sign-out is in flight.
let manualSignOutInFlight = false;

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [emailVerified, setEmailVerified] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Set up auth state listener FIRST
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        console.log('Auth state changed:', event, session?.user?.email);

        // SIGNED_OUT can be fired by the SDK for transient reasons (a single
        // failed token refresh, a network blip, another tab rotating the
        // refresh token, etc.). Only clear local state when the user asked to
        // sign out OR when a fresh getSession() confirms there really is no
        // session left. This prevents users from being kicked to /login
        // without their consent.
        if (event === 'SIGNED_OUT') {
          if (manualSignOutInFlight) {
            setSession(null);
            setUser(null);
            setEmailVerified(false);
            setLoading(false);
            return;
          }
          // Re-verify before clearing — give the SDK a moment to settle.
          setTimeout(async () => {
            try {
              const { data } = await supabase.auth.getSession();
              if (data?.session?.user) {
                console.log('Ignored spurious SIGNED_OUT — session still valid');
                setSession(data.session);
                setUser(data.session.user);
                setEmailVerified(Boolean(data.session.user.email_confirmed_at));
                setLoading(false);
                return;
              }
              console.log('SIGNED_OUT confirmed by getSession — clearing local state');
              setSession(null);
              setUser(null);
              setEmailVerified(false);
              setLoading(false);
            } catch (err) {
              // If we can't verify (network down), DO NOT sign the user out.
              console.warn('Could not verify SIGNED_OUT — keeping session.', err);
            }
          }, 250);
          return;
        }

        const isEmailVerified = Boolean(session?.user?.email_confirmed_at);

        // Only validate email + account status on the initial SIGNED_IN.
        // TOKEN_REFRESHED fires frequently (every ~hour) and a transient
        // profile fetch failure must NOT sign the user out.
        if (session?.user && event === 'SIGNED_IN') {
          if (!isEmailVerified) {
            setSession(null);
            setUser(null);
            setEmailVerified(false);
            setLoading(false);
            manualSignOutInFlight = true;
            try {
              await supabase.auth.signOut();
            } finally {
              manualSignOutInFlight = false;
            }
            toast.error('Please verify your email before accessing your account.');
            return;
          }

          // Check account status — use setTimeout to avoid Supabase deadlock
          setTimeout(async () => {
            const allowed = await checkAccountStatus(session.user.id);
            if (!allowed) {
              setSession(null);
              setUser(null);
              setLoading(false);
              return;
            }
          }, 0);
        }

        setSession(session);
        setUser(session?.user ?? null);
        setEmailVerified(isEmailVerified);
        setLoading(false);
      }
    );

    // THEN check for existing session. We want to AVOID releasing
    // loading=false prematurely while a valid token is sitting in localStorage
    // — otherwise ProtectedRoute will flash the login screen / redirect a
    // signed-in user. Strategy:
    //   - if NO sb-*-auth-token in localStorage → user is truly signed out;
    //     release loading quickly (1.5s) so /login renders.
    //   - if a token IS present → it's just hydration latency; keep the
    //     spinner up to 12s while getSession() resolves.
    let initialResolved = false;
    const hasStoredToken = (() => {
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith('sb-') && k.endsWith('-auth-token')) return true;
        }
      } catch { /* ignore */ }
      return false;
    })();

    const initialSessionTimeout = setTimeout(() => {
      if (!initialResolved) {
        console.warn('Initial getSession() slow — releasing loading without clearing session.');
        setLoading(false);
      }
    }, hasStoredToken ? 12000 : 1500);

    supabase.auth.getSession().then(({ data: { session } }) => {
      initialResolved = true;
      clearTimeout(initialSessionTimeout);
      const isEmailVerified = Boolean(session?.user?.email_confirmed_at);
      setSession(isEmailVerified ? session : null);
      setUser(isEmailVerified ? session?.user ?? null : null);
      setEmailVerified(isEmailVerified);
      setLoading(false);
    }).catch((err) => {
      initialResolved = true;
      clearTimeout(initialSessionTimeout);
      console.warn('Initial getSession() failed:', err);
      setLoading(false);
    });

    // Cross-tab session sync: when another tab signs in/out, Supabase writes
    // to localStorage. Mirror that into this tab's React state immediately so
    // a second tab doesn't need a manual refresh.
    const onStorage = (e: StorageEvent) => {
      if (!e.key || !e.key.startsWith('sb-') || !e.key.endsWith('-auth-token')) return;
      supabase.auth.getSession().then(({ data: { session } }) => {
        const isEmailVerified = Boolean(session?.user?.email_confirmed_at);
        setSession(isEmailVerified ? session : null);
        setUser(isEmailVerified ? session?.user ?? null : null);
        setEmailVerified(isEmailVerified);
        setLoading(false);
      }).catch(() => { /* ignore */ });
    };
    window.addEventListener('storage', onStorage);

    return () => {
      subscription.unsubscribe();
      window.removeEventListener('storage', onStorage);
      clearTimeout(initialSessionTimeout);
    };
  }, []);

  const signOut = async () => {
    manualSignOutInFlight = true;
    // Broadcast to ArbiProSeller Chrome extensions BEFORE we tear down the
    // Supabase session so their content scripts can forward the signal.
    try {
      window.postMessage({ type: "ARBIPRO_EXT_LOGOUT" }, window.location.origin);
      console.log("[arbipro-auth]", "web_logout_broadcasted");
    } catch (_) { /* ignore */ }

    // 1. Clear local session FIRST so the UI updates immediately, even if the
    //    auth server is slow/unreachable. Without this, a hanging global
    //    signOut() call leaves the user "stuck logged in".
    try {
      await supabase.auth.signOut({ scope: 'local' });
    } catch (e) {
      console.warn('Local sign-out failed', e);
    }
    setUser(null);
    setSession(null);
    setEmailVerified(false);

    // 2. Fire the global server-side sign-out in the background with a hard
    //    timeout. We don't await it — the user is already logged out locally.
    void (async () => {
      try {
        await Promise.race([
          supabase.auth.signOut({ scope: 'global' }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('global signOut timeout')), 4000)
          ),
        ]);
      } catch (error) {
        console.warn('Global sign-out failed or timed out (local session already cleared).', error);
      } finally {
        manualSignOutInFlight = false;
      }
    })();
  };

  return (
    <AuthContext.Provider value={{ user, session, emailVerified, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
