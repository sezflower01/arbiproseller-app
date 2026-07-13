import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { Download, ShieldCheck } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

const ADMIN_DOWNLOAD_URL =
  "https://mstibdszibcheodvnprm.supabase.co/storage/v1/object/sign/access/Setup_ArbiProSeller.exe?token=eyJraWQiOiJzdG9yYWdlLXVybC1zaWduaW5nLWtleV9iODE0YWYxZi1jYzk3LTQ2MTAtOTc1ZC03ZjY4YWMxNGY1MjQiLCJhbGciOiJIUzI1NiJ9.eyJ1cmwiOiJhY2Nlc3MvU2V0dXBfQXJiaVByb1NlbGxlci5leGUiLCJpYXQiOjE3NzQ1ODc1MjcsImV4cCI6MjAyNjg3NTUyN30.VT9dF4S4XUvteaL7Q6zjGhW19OmhLbIlDtKX7qR_ohU";

const AdminDownload = () => {
  const navigate = useNavigate();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  useEffect(() => {
    const check = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setIsAdmin(false); return; }

      const { data } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", user.id)
        .eq("role", "admin")
        .maybeSingle();

      setIsAdmin(!!data);
    };
    check();
  }, []);

  if (isAdmin === null) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="min-h-screen flex flex-col">
        <Navbar />
        <main className="flex-grow flex items-center justify-center">
          <div className="text-center space-y-4">
            <ShieldCheck className="mx-auto h-16 w-16 text-destructive" />
            <h1 className="text-2xl font-bold">Access Denied</h1>
            <p className="text-muted-foreground">This page is restricted to administrators.</p>
            <Button onClick={() => navigate("/")}>Go Home</Button>
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />
      <main className="flex-grow pt-24 pb-16">
        <div className="container mx-auto px-4 max-w-2xl text-center space-y-8">
          <ShieldCheck className="mx-auto h-16 w-16 text-primary" />
          <h1 className="text-3xl font-bold">Admin Download</h1>
          <p className="text-muted-foreground">
            Download the full Inventory S.P.R.I.N.T. installer with SP-API integration.
          </p>
          <Button
            size="lg"
            className="bg-gradient-to-r from-purple-600 to-blue-500 hover:from-purple-700 hover:to-blue-600 text-white px-8 py-6 h-auto text-lg"
            onClick={() => window.open(ADMIN_DOWNLOAD_URL, "_blank")}
          >
            <Download className="mr-2" size={24} />
            Download Setup_ArbiProSeller.exe
          </Button>
        </div>
      </main>
      <Footer />
    </div>
  );
};

export default AdminDownload;
