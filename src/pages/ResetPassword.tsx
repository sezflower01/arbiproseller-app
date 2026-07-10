import { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { Loader2, AlertCircle } from 'lucide-react';
import Navbar from '@/components/Navbar';
import Footer from '@/components/Footer';
import { Helmet } from 'react-helmet-async';
import { Alert, AlertDescription } from '@/components/ui/alert';

const darkBg = "bg-gradient-to-br from-[hsl(222,84%,4.9%)] via-[hsl(230,50%,10%)] to-[hsl(260,50%,8%)]";

const BgOrbs = () => (
  <>
    <div className="absolute top-1/4 -left-32 w-96 h-96 bg-primary/20 rounded-full blur-[120px] animate-pulse" />
    <div className="absolute bottom-1/4 -right-32 w-96 h-96 bg-purple-500/15 rounded-full blur-[120px] animate-pulse" style={{ animationDelay: '1s' }} />
    <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:64px_64px]" />
  </>
);

export default function ResetPassword() {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [isValidSession, setIsValidSession] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const [urlError, setUrlError] = useState<string | null>(null);
  const { toast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    // Check for error in URL hash (e.g., #error=access_denied&error_code=otp_expired)
    const hash = window.location.hash.substring(1);
    const params = new URLSearchParams(hash);
    const error = params.get('error');
    const errorCode = params.get('error_code');
    const errorDescription = params.get('error_description');
    
    if (error || errorCode) {
      console.log('URL error detected:', { error, errorCode, errorDescription });
      const message = errorDescription 
        ? decodeURIComponent(errorDescription.replace(/\+/g, ' '))
        : 'The password reset link is invalid or has expired.';
      setUrlError(message);
      setCheckingSession(false);
      return;
    }

    // Check if user has a valid session for password recovery
    const checkSession = async () => {
      try {
        const { data: { session }, error } = await supabase.auth.getSession();
        
        if (error) {
          console.error('Session check error:', error);
          setIsValidSession(false);
        } else if (session) {
          setIsValidSession(true);
        } else {
          setIsValidSession(false);
        }
      } catch (error) {
        console.error('Error checking session:', error);
        setIsValidSession(false);
      } finally {
        setCheckingSession(false);
      }
    };

    checkSession();

    // Listen for auth state changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      console.log('Auth event:', event);
      if (event === "PASSWORD_RECOVERY") {
        setIsValidSession(true);
        setCheckingSession(false);
      } else if (session) {
        // User has a valid session (from clicking the reset link)
        setIsValidSession(true);
        setCheckingSession(false);
      }
    });

    return () => subscription.unsubscribe();
  }, [location]);

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!password || !confirmPassword) {
      toast({
        title: "Missing information",
        description: "Please fill in all fields",
        variant: "destructive",
      });
      return;
    }

    if (password.length < 6) {
      toast({
        title: "Password too short",
        description: "Password must be at least 6 characters",
        variant: "destructive",
      });
      return;
    }

    if (password !== confirmPassword) {
      toast({
        title: "Passwords don't match",
        description: "Please make sure both passwords match",
        variant: "destructive",
      });
      return;
    }

    setLoading(true);

    try {
      const { error } = await supabase.auth.updateUser({
        password: password
      });

      if (error) throw error;

      toast({
        title: "Password updated!",
        description: "Your password has been successfully reset",
      });

      navigate('/login');
    } catch (error: any) {
      console.error('Password update error:', error);
      toast({
        title: "Update failed",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  if (checkingSession) {
    return (
      <div className="min-h-screen flex flex-col">
        <Helmet>
          <title>Reset Password | ArbiProSeller</title>
        </Helmet>
        <Navbar />
        <main className={`flex-grow pt-16 flex items-center justify-center px-4 py-12 relative overflow-hidden ${darkBg}`}>
          <BgOrbs />
          <div className="text-center relative z-10">
            <Loader2 className="h-8 w-8 animate-spin mx-auto text-primary" />
            <p className="mt-4 text-gray-400">Verifying reset link...</p>
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  if (urlError || !isValidSession) {
    return (
      <div className="min-h-screen flex flex-col">
        <Helmet>
          <title>Reset Password | ArbiProSeller</title>
        </Helmet>
        <Navbar />
        <main className={`flex-grow pt-16 flex items-center justify-center px-4 py-12 relative overflow-hidden ${darkBg}`}>
          <BgOrbs />
          <div className="max-w-md w-full space-y-6 relative z-10">
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                {urlError || 'This password reset link is invalid or has expired. Please request a new password reset link.'}
              </AlertDescription>
            </Alert>
            <p className="text-sm text-gray-400 text-center">
              Password reset links can only be used once and expire after 24 hours.
            </p>
            <div className="text-center">
              <Button onClick={() => navigate('/forgot-password')}>
                Request New Reset Link
              </Button>
            </div>
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Helmet>
        <title>Reset Password | ArbiProSeller</title>
      </Helmet>
      <Navbar />
      <main className={`flex-grow pt-16 flex items-center justify-center px-4 py-12 relative overflow-hidden ${darkBg}`}>
        <BgOrbs />
        <div className="max-w-md w-full space-y-8 relative z-10">
          <div className="text-center">
            <h1 className="text-4xl font-bold mb-2 text-white">Reset your password</h1>
            <p className="text-gray-400">
              Enter your new password below
            </p>
          </div>

          <form onSubmit={handleResetPassword} className="space-y-6 bg-white/[0.03] backdrop-blur-sm p-8 rounded-2xl border border-white/10 shadow-lg">
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="password" className="text-gray-300">New Password</Label>
                <Input
                  id="password"
                  type="password"
                  placeholder="Enter new password (min 6 characters)"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  disabled={loading}
                  minLength={6}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="confirmPassword" className="text-gray-300">Confirm Password</Label>
                <Input
                  id="confirmPassword"
                  type="password"
                  placeholder="Confirm new password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  disabled={loading}
                  minLength={6}
                />
              </div>
            </div>

            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Updating password...
                </>
              ) : (
                'Update Password'
              )}
            </Button>
          </form>
        </div>
      </main>
      <Footer />
    </div>
  );
}
