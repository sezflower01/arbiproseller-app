import { useNavigate, useSearchParams } from "react-router-dom";
import { Helmet } from "react-helmet-async";
import { Button } from "@/components/ui/button";
import { Home } from "lucide-react";

const SignedIn = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const target = searchParams.get("redirect") || "/";

  return (
    <div>
      <Helmet>
        <title>You are logged in | ArbiProSeller</title>
        <meta name="description" content="You are logged in to ArbiProSeller. Continue to your dashboard." />
        <link rel="canonical" href={`${window.location.origin}/auth/signed-in`} />
      </Helmet>

      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <div className="text-center bg-white p-8 rounded-lg shadow-md max-w-md">
          <h1 className="text-3xl font-bold mb-4 text-gray-800">You are logged in</h1>
          <p className="text-gray-600 mb-6">Welcome back! Click the button below to continue.</p>
          <Button onClick={() => navigate(target)} className="bg-gradient-to-r from-blue-600 to-cyan-500 hover:from-blue-700 hover:to-cyan-600">
            <Home className="mr-2" size={18} />
            Return to Home
          </Button>
        </div>
      </div>
    </div>
  );
};

export default SignedIn;
