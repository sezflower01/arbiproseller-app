import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { Loader2 } from 'lucide-react';

/**
 * "Continue with Google" button.
 *
 * Why this exists:
 *   Browser localStorage is per-browser, so opening the app in a second
 *   browser would normally force a full email+password re-login. Google
 *   OAuth makes that second login a single click when the same Google
 *   account is already active in the browser — which is the practical
 *   answer to the cross-browser problem.
 *
 * Behavior:
 *   - Redirects to /auth/callback after Google completes.
 *   - Preserves the caller's intended post-login redirect via ?redirect=...
 *   - Persistent Supabase session + auto-refresh is configured on the
 *     client itself (storage: localStorage, persistSession: true,
 *     autoRefreshToken: true) — that's what keeps the user logged in
 *     across reloads and browser restarts on the same browser.
 */
type Props = {
  redirectTo?: string | null;
  label?: string;
  className?: string;
};

export default function GoogleSignInButton({ redirectTo, label = 'Continue with Google', className }: Props) {
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();
  const location = useLocation();

  const handleClick = async () => {
    setLoading(true);
    try {
      // Resolve the post-login target: explicit prop > ?redirect= > location.state.redirect > '/'
      const queryRedirect = new URLSearchParams(location.search).get('redirect');
      const stateRedirect = (location.state as any)?.redirect;
      const intended = redirectTo ?? queryRedirect ?? stateRedirect ?? '/';

      const callbackUrl = `${window.location.origin}/auth/callback?redirect=${encodeURIComponent(intended)}`;

      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: callbackUrl,
          queryParams: {
            // Always show account chooser so users on shared machines can pick.
            // Remove "select_account" later if you want true one-click.
            access_type: 'offline',
            prompt: 'select_account',
          },
        },
      });

      if (error) throw error;
      // On success, the browser navigates to Google; nothing else to do here.
    } catch (err: any) {
      console.error('Google sign-in error:', err);
      toast({
        title: 'Google sign-in failed',
        description:
          err?.message ||
          'Could not start Google sign-in. If this keeps happening, use email + password below.',
        variant: 'destructive',
      });
      setLoading(false);
    }
  };

  return (
    <Button
      type="button"
      onClick={handleClick}
      disabled={loading}
      variant="outline"
      className={
        className ??
        'w-full bg-white text-gray-900 hover:bg-gray-100 border-white/20 font-medium'
      }
    >
      {loading ? (
        <>
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          Opening Google…
        </>
      ) : (
        <>
          {/* Inline Google "G" logo so we don't pull a new dependency */}
          <svg className="mr-2 h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
            <path
              fill="#4285F4"
              d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
            />
            <path
              fill="#34A853"
              d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.99.66-2.26 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
            />
            <path
              fill="#FBBC05"
              d="M5.84 14.1c-.22-.66-.35-1.36-.35-2.1s.13-1.44.35-2.1V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.83z"
            />
            <path
              fill="#EA4335"
              d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"
            />
          </svg>
          {label}
        </>
      )}
    </Button>
  );
}
