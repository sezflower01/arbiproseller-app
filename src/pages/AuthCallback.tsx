import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Loader2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import type { Session } from '@supabase/supabase-js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const withTimeout = async <T,>(promise: Promise<T>, ms: number, message: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const getCallbackSession = async (): Promise<Session> => {
  const params = new URLSearchParams(window.location.search);
  const providerError = params.get('error_description') || params.get('error');
  if (providerError) throw new Error(providerError);

  // With detectSessionInUrl: true (see supabase client config), the SDK
  // automatically exchanges the OAuth code on page load. Racing it with a
  // manual exchangeCodeForSession() causes one of them to hang because the
  // PKCE verifier is consumed by whichever wins. Instead, just wait for the
  // SDK to finish and emit a session — either via onAuthStateChange or via
  // getSession() polling.

  // 1) Fast path: session already present.
  try {
    const { data } = await withTimeout(
      supabase.auth.getSession(),
      5000,
      'getSession timed out'
    );
    if (data?.session) return data.session;
  } catch (err) {
    console.warn('Initial getSession failed, will wait for auth event.', err);
  }

  // 2) Wait for SIGNED_IN / INITIAL_SESSION from the SDK, with polling as backup.
  // Do not manually call exchangeCodeForSession() here. With detectSessionInUrl
  // enabled, the SDK owns the PKCE code exchange; a second exchange can consume
  // the verifier or race the auto-exchange and produce a false failure.
  return await new Promise<Session>((resolve, reject) => {
    let settled = false;
    const cleanup: Array<() => void> = [];
    let pollInFlight = false;

    const finish = (s: Session | null, err?: Error) => {
      if (settled) return;
      settled = true;
      cleanup.forEach((fn) => fn());
      if (s) resolve(s);
      else reject(err ?? new Error('Sign-in completed, but no session was created. Please try again.'));
    };

    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (session && (event === 'SIGNED_IN' || event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED')) {
        finish(session);
      }
    });
    cleanup.push(() => data.subscription.unsubscribe());

    const poll = setInterval(async () => {
      if (pollInFlight) return;
      pollInFlight = true;
      try {
        const { data } = await withTimeout(
          supabase.auth.getSession(),
          10000,
          'poll getSession timed out'
        );
        if (data?.session) finish(data.session);
      } catch { /* ignore */ }
      finally {
        pollInFlight = false;
      }
    }, 750);
    cleanup.push(() => clearInterval(poll));

    const hardTimeout = setTimeout(async () => {
      try {
        const { data } = await withTimeout(
          supabase.auth.getSession(),
          5000,
          'final getSession timed out'
        );
        if (data?.session) {
          finish(data.session);
          return;
        }
      } catch { /* ignore */ }

      finish(null, new Error('Sign-in did not complete. Please try Continue with Google again.'));
    }, 45000);
    cleanup.push(() => clearTimeout(hardTimeout));
  });
};

export default function AuthCallback() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { toast } = useToast();
  const [processing, setProcessing] = useState(true);
  const handledRef = useRef(false);

  useEffect(() => {
    const handleAuthCallback = async () => {
      if (handledRef.current) return;
      handledRef.current = true;

      try {
        const session = await getCallbackSession();

        const user = session.user;
        const metadata = user.user_metadata;

        // Accept names from either our own signup metadata (first_name/last_name)
        // or Google OAuth metadata (given_name/family_name, or split from full name).
        const fullName: string = metadata?.full_name || metadata?.name || '';
        const [splitFirst, ...splitRest] = fullName.trim().split(/\s+/);
        const firstName = metadata?.first_name || metadata?.given_name || splitFirst || '';
        const lastName  = metadata?.last_name  || metadata?.family_name || splitRest.join(' ') || '';

        if (!firstName || !lastName) {
          // Still missing — send them to complete profile.
          navigate('/account/complete-profile', { replace: true });
          return;
        }

        // Fire-and-forget profile upsert — never block the redirect on it.
        // Slow/failed profile writes were causing "Completing sign in…" to hang.
        supabase
          .from('profiles')
          .upsert(
            {
              id: user.id,
              email: user.email!,
              first_name: firstName,
              last_name: lastName,
            },
            { onConflict: 'id' },
          )
          .then(({ error: profileError }) => {
            if (profileError) console.error('Profile upsert error:', profileError);
          });

        // Admin-gated onboarding: block sign-in unless approved (admins pass).
        const { data: approved, error: approvedErr } = await supabase.rpc('is_self_approved');
        if (approvedErr) console.warn('is_self_approved failed', approvedErr);
        if (!approved) {
          await supabase.auth.signOut();
          toast({
            title: 'Account pending approval',
            description: "Thanks for signing up! We'll email you as soon as an admin approves your account.",
          });
          navigate('/login', { replace: true });
          return;
        }

        toast({
          title: 'Welcome!',
          description: `You're now logged in as ${firstName} ${lastName}`,
        });

        // Redirect straight into the app — no intermediate "/auth/signed-in"
        // waiting page (users mistook it for the spinner still loading).
        const intended = searchParams.get('redirect');
        const target = intended && intended !== '/login' ? intended : '/';
        navigate(target, { replace: true });


      } catch (error: unknown) {
        console.error('Auth callback error:', error);
        const message = error instanceof Error ? error.message : 'Something went wrong during sign in';
        toast({
          title: "Authentication failed",
          description: message,
          variant: "destructive",
        });
        navigate('/login', { replace: true });
      } finally {
        setProcessing(false);
      }
    };

    handleAuthCallback();
  }, [navigate, searchParams, toast]);

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center space-y-4">
        <Loader2 className="h-12 w-12 animate-spin text-primary mx-auto" />
        <p className="text-muted-foreground">
          {processing ? 'Completing sign in...' : 'Redirecting...'}
        </p>
      </div>
    </div>
  );
}
