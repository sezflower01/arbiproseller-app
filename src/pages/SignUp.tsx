import { useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { Loader2, CheckCircle, Eye, EyeOff } from 'lucide-react';
import GoogleSignInButton from '@/components/auth/GoogleSignInButton';
import Navbar from '@/components/Navbar';
import Footer from '@/components/Footer';
import { Helmet } from 'react-helmet-async';

export default function SignUp() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const { toast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const redirectTo = (location.state as any)?.redirect;

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!email || !password || !firstName || !lastName) {
      toast({ title: "Missing information", description: "Please fill in all fields", variant: "destructive" });
      return;
    }

    if (password.length < 6) {
      toast({ title: "Password too short", description: "Password must be at least 6 characters", variant: "destructive" });
      return;
    }

    if (password !== confirmPassword) {
      toast({ title: "Passwords don't match", description: "Please make sure both passwords match", variant: "destructive" });
      return;
    }

    setLoading(true);

    try {
      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: window.location.origin,
          data: {
            first_name: firstName,
            last_name: lastName,
          },
        },
      });

      if (error) throw error;

      // Admin-gated onboarding: brand-new accounts are pending until an admin
      // approves them. Immediately sign the user out so they can't slip past
      // the login gate, and show the "thank you for your interest" screen.
      try { await supabase.auth.signOut(); } catch { /* ignore */ }

      setSubmitted(true);
      toast({
        title: "Thank you for your interest!",
        description: "We'll email you as soon as your account is approved.",
      });
    } catch (error: any) {
      console.error('Sign up error:', error);
      toast({
        title: "Sign up failed",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };


  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-br from-[hsl(222,84%,4.9%)] via-[hsl(230,50%,10%)] to-[hsl(260,50%,8%)] relative overflow-hidden">
      <div className="absolute top-1/4 -left-32 w-96 h-96 bg-primary/20 rounded-full blur-[120px] animate-pulse" />
      <div className="absolute bottom-1/4 -right-32 w-96 h-96 bg-purple-500/15 rounded-full blur-[120px] animate-pulse" style={{ animationDelay: '1s' }} />
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-primary/5 rounded-full blur-[200px]" />
      <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:64px_64px]" />

      <Helmet>
        <title>Sign Up - ArbiProSeller</title>
        <meta name="description" content="Create your ArbiProSeller account and start your 60-day free trial." />
      </Helmet>
      <Navbar />
      <main className="flex-grow pt-16 flex items-center justify-center px-4 py-12 relative z-10">
        <div className="max-w-md w-full space-y-8">
          {submitted ? (
            <div className="text-center space-y-6 bg-white/[0.03] border border-white/10 backdrop-blur-sm p-8 rounded-2xl shadow-2xl">
              <div className="mx-auto w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center">
                <CheckCircle className="w-8 h-8 text-primary" />
              </div>
              <h1 className="text-3xl font-bold text-white">Thank you for your interest!</h1>
              <p className="text-gray-400">
                We've received your request for <strong className="text-white">{email}</strong>.
                Our team reviews every new account before activation — we'll send you an email
                showing how to log in and start using <strong className="text-white">ArbiProSeller</strong>
                as soon as your account is approved.
              </p>
              <Link to="/">
                <Button variant="outline" className="mt-4 border-white/20 text-white hover:bg-white/10">
                  Back to Home
                </Button>
              </Link>

            </div>
          ) : (
            <>
              <div className="text-center">
                <h1 className="text-4xl font-bold mb-2 text-white">Create Account</h1>
                <p className="text-gray-400">
                  Sign up and start your 60-day free trial — no credit card required.
                </p>
              </div>

              <div className="space-y-4 bg-white/[0.03] border border-white/10 backdrop-blur-sm p-8 rounded-2xl shadow-2xl">
                <GoogleSignInButton label="Sign up with Google" />
                <p className="text-[11px] text-center text-gray-500">
                  Fastest way to sign up — and one-click login from any browser where you're signed into Google.
                </p>
                <div className="relative my-2">
                  <div className="absolute inset-0 flex items-center"><span className="w-full border-t border-white/10" /></div>
                  <div className="relative flex justify-center text-xs"><span className="bg-[#0c1430] px-3 text-gray-400">or sign up with email</span></div>
                </div>
              <form onSubmit={handleSignUp} className="space-y-6">
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="firstName" className="text-gray-300">First Name</Label>
                      <Input
                        id="firstName"
                        type="text"
                        placeholder="John"
                        value={firstName}
                        onChange={(e) => setFirstName(e.target.value)}
                        required
                        disabled={loading}
                        className="bg-white/[0.05] border-white/10 text-white placeholder:text-gray-500 focus:border-primary"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="lastName" className="text-gray-300">Last Name</Label>
                      <Input
                        id="lastName"
                        type="text"
                        placeholder="Doe"
                        value={lastName}
                        onChange={(e) => setLastName(e.target.value)}
                        required
                        disabled={loading}
                        className="bg-white/[0.05] border-white/10 text-white placeholder:text-gray-500 focus:border-primary"
                      />
                    </div>
                  </div>

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
                        placeholder="••••••••"
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

                  <div className="space-y-2">
                    <Label htmlFor="confirmPassword" className="text-gray-300">Confirm Password</Label>
                    <div className="relative">
                      <Input
                        id="confirmPassword"
                        type={showConfirmPassword ? "text" : "password"}
                        placeholder="••••••••"
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        required
                        disabled={loading}
                        className="bg-white/[0.05] border-white/10 text-white placeholder:text-gray-500 focus:border-primary pr-10"
                      />
                      <button
                        type="button"
                        onClick={() => setShowConfirmPassword(v => !v)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white"
                        tabIndex={-1}
                        aria-label={showConfirmPassword ? "Hide password" : "Show password"}
                      >
                        {showConfirmPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>
                </div>

                <Button type="submit" className="w-full bg-primary hover:bg-primary/90 text-primary-foreground font-semibold shadow-lg shadow-primary/25 hover:shadow-xl hover:shadow-primary/30 transition-all duration-300" disabled={loading}>
                  {loading ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Creating account...
                    </>
                  ) : (
                    'Sign Up'
                  )}
                </Button>

                <p className="text-xs text-center text-gray-500">
                  By continuing, you agree to our{' '}
                  <Link to="/terms" className="underline hover:text-primary text-gray-400">Terms</Link>
                  {' '}and acknowledge our{' '}
                  <Link to="/privacy" className="underline hover:text-primary text-gray-400">Privacy Policy</Link>
                </p>
              </form>
              </div>

              <p className="text-center text-sm text-gray-400">
                Already have an account?{' '}
                <Link to="/login" className="text-primary font-medium hover:underline">
                  Log in
                </Link>
              </p>
            </>
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
}
