import { useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Eye, EyeOff } from 'lucide-react';
import GoogleSignInButton from '@/components/auth/GoogleSignInButton';
import Navbar from '@/components/Navbar';
import Footer from '@/components/Footer';
import { Helmet } from 'react-helmet-async';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [resendingEmail, setResendingEmail] = useState(false);
  const [showResendOption, setShowResendOption] = useState(false);
  const { toast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const redirectState = (location.state as any)?.redirect;
  const redirectQuery = new URLSearchParams(location.search).get('redirect');

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!email || !password) {
      toast({
        title: "Missing information",
        description: "Please enter your email and password",
        variant: "destructive",
      });
      return;
    }

    setLoading(true);

    try {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) {
        // Check if error is about email not confirmed
        if (error.message.toLowerCase().includes('email not confirmed')) {
          setShowResendOption(true);
          toast({
            title: "Email not verified",
            description: "Please verify your email. Click 'Resend Verification Email' below if your link expired.",
            variant: "destructive",
          });
        } else {
          throw error;
        }
        return;
      }

      // Admin-gated onboarding: block login unless the account has been approved
      // (admins always pass).
      const { data: approved, error: approvedErr } = await supabase.rpc('is_self_approved');
      if (approvedErr) console.warn('is_self_approved failed', approvedErr);
      if (!approved) {
        await supabase.auth.signOut();
        toast({
          title: "Account pending approval",
          description: "Your account is being reviewed. We'll email you as soon as it's approved.",
          variant: "destructive",
        });
        return;
      }

      toast({
        title: "Welcome back!",
        description: "You've been successfully logged in",
      });


      const redirectPath = redirectState || redirectQuery || '/';
      navigate(redirectPath);
    } catch (error: any) {
      console.error('Login error:', error);
      toast({
        title: "Login failed",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleResendVerification = async () => {
    if (!email) {
      toast({
        title: "Email required",
        description: "Please enter your email address first",
        variant: "destructive",
      });
      return;
    }

    setResendingEmail(true);

    try {
      const { error } = await supabase.auth.resend({
        type: 'signup',
        email: email,
      });

      if (error) throw error;

      toast({
        title: "Verification email sent!",
        description: "Please check your inbox and click the verification link.",
      });
    } catch (error: any) {
      console.error('Resend error:', error);
      toast({
        title: "Failed to resend",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setResendingEmail(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-br from-[hsl(222,84%,4.9%)] via-[hsl(230,50%,10%)] to-[hsl(260,50%,8%)] relative overflow-hidden">
      {/* Animated gradient orbs — matching Hero */}
      <div className="absolute top-1/4 -left-32 w-96 h-96 bg-primary/20 rounded-full blur-[120px] animate-pulse" />
      <div className="absolute bottom-1/4 -right-32 w-96 h-96 bg-purple-500/15 rounded-full blur-[120px] animate-pulse" style={{ animationDelay: '1s' }} />
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-primary/5 rounded-full blur-[200px]" />
      <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:64px_64px]" />

      <Helmet>
        <title>Log In - Access Your Free Tools | ArbiProSeller</title>
        <meta name="description" content="Log in to your ArbiProSeller account to access free seller tools." />
      </Helmet>
      <Navbar />
      <main className="flex-grow pt-16 flex items-center justify-center px-4 py-12 relative z-10">
        <div className="max-w-md w-full space-y-8">
          <div className="text-center">
            <h1 className="text-4xl font-bold mb-2 text-white">Welcome back</h1>
            <p className="text-gray-400">
              Log in to access your free seller tools
            </p>
          </div>

          <div className="space-y-4 bg-white/[0.03] border border-white/10 backdrop-blur-sm p-8 rounded-2xl shadow-2xl">
            <GoogleSignInButton />
            <p className="text-[11px] text-center text-gray-500">
              One-click sign-in if you're already signed into Google in this browser.
            </p>
            <div className="relative my-2">
              <div className="absolute inset-0 flex items-center"><span className="w-full border-t border-white/10" /></div>
              <div className="relative flex justify-center text-xs"><span className="bg-[#0c1430] px-3 text-gray-400">or continue with email</span></div>
            </div>
          <form onSubmit={handleLogin} className="space-y-6">
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email" className="text-gray-300">Email</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  disabled={loading}
                  className="bg-white/[0.05] border-white/10 text-white placeholder:text-gray-500 focus:border-primary"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="password" className="text-gray-300">Password</Label>
                <div className="relative">
                  <Input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    placeholder="Enter your password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    disabled={loading}
                    className="bg-white/[0.05] border-white/10 text-white placeholder:text-gray-500 focus:border-primary pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(v => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white"
                    tabIndex={-1}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
            </div>

            <Button type="submit" className="w-full bg-primary hover:bg-primary/90 text-primary-foreground font-semibold shadow-lg shadow-primary/25 hover:shadow-xl hover:shadow-primary/30 transition-all duration-300" disabled={loading}>
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Logging in...
                </>
              ) : (
                'Log In'
              )}
            </Button>

            {showResendOption && (
              <div className="text-center">
                <Button 
                  type="button"
                  variant="outline" 
                  className="w-full border-white/20 text-white hover:bg-white/10"
                  onClick={handleResendVerification}
                  disabled={resendingEmail}
                >
                  {resendingEmail ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Resending...
                    </>
                  ) : (
                    'Resend Verification Email'
                  )}
                </Button>
              </div>
            )}

            <div className="text-center">
              <Link 
                to="/forgot-password" 
                className="text-sm text-primary hover:underline"
              >
                Forgot password?
              </Link>
            </div>
          </form>
          </div>

          <p className="text-center text-sm text-gray-400">
            Don't have an account?{' '}
            <Link 
              to="/signup"
              className="text-primary font-medium hover:underline"
            >
              Sign up
            </Link>
          </p>
        </div>
      </main>
      <Footer />
    </div>
  );
}
