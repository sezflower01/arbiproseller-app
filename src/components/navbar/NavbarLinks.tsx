import React, { useEffect, useState } from "react";
import { ShoppingCart, ChevronDown, Lock, LayoutGrid, BookOpen, Package, Zap, Library, Sparkles, Tag } from "lucide-react";
import { useNavigate } from "react-router-dom";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useLanguage } from "@/contexts/LanguageContext";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import UserMenu from "./UserMenu";
import RequireAuthLink from "@/components/RequireAuthLink";
import { TOOLS } from "@/config/tools";
import { ExpenseDialog } from "@/components/sales/ExpenseDialog";
import SalesSyncButton from "./SalesSyncButton";
import PlatformModulesMenu from "./PlatformModulesMenu";
import ProductsMegaMenu from "./ProductsMegaMenu";
import BbPriceAlerts from "./BbPriceAlerts";
import HijackerAlerts from "./HijackerAlerts";
import AdminChatNotification from "@/components/chat/AdminChatNotification";
import AdminErrorNotification from "@/components/chat/AdminErrorNotification";


export interface NavbarLinksProps {
  goToHome: () => void;
  handleNavigation: (section: string) => void;
  goToDownloadPage: () => void;
  goToBuyLicense: () => void;
  linkClass?: string;
}

const NavbarLinks: React.FC<NavbarLinksProps> = ({
  goToHome,
  handleNavigation,
  goToDownloadPage,
  goToBuyLicense,
  linkClass = "font-medium text-brand-600 hover:text-brand-700 transition-colors cursor-pointer"
}) => {
  const { t, language } = useLanguage();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    const checkAdmin = async () => {
      if (!user) {
        console.log("NavbarLinks: No user, setting isAdmin to false");
        setIsAdmin(false);
        return;
      }
      
      console.log("NavbarLinks: Checking admin status for user:", user.id);
      const { data, error } = await supabase
        .from('user_roles')
        .select('role')
        .eq('user_id', user.id)
        .eq('role', 'admin')
        .maybeSingle();
      
      if (error) {
        console.error("NavbarLinks: Error checking admin status:", error);
        setIsAdmin(false);
        return;
      }
      
      const hasAdminRole = !!data;
      console.log("NavbarLinks: Admin status result:", hasAdminRole, data);
      setIsAdmin(hasAdminRole);
    };
    checkAdmin();
  }, [user]);
  
  const spacingClass = (language === 'es') ? 'space-x-1.5' : 'space-x-2';
  
  const handleAboutClick = () => {
    if (typeof gtag !== 'undefined') {
      gtag('event', 'navigation_click', {
        event_category: 'engagement',
        event_label: 'about_us_nav',
        value: 1
      });
    }
    navigate('/about');
  };

  const handleContactClick = () => {
    if (typeof gtag !== 'undefined') {
      gtag('event', 'navigation_click', {
        event_category: 'engagement',
        event_label: 'contact_nav',
        value: 1
      });
    }
    navigate('/contact');
  };

  const handleDownloadClick = () => {
    if (typeof gtag !== 'undefined') {
      gtag('event', 'navigation_click', {
        event_category: 'engagement',
        event_label: 'download_nav',
        value: 1
      });
    }
    goToDownloadPage();
  };

  const handleBuyLicenseClick = () => {
    if (typeof gtag !== 'undefined') {
      gtag('event', 'navigation_click', {
        event_category: 'engagement',
        event_label: 'buy_license_nav',
        value: 1
      });
    }
    goToBuyLicense();
  };

  const blogItems = [
    { to: "/blog/repricer-features", title: "Every Feature Inside Our AI Repricer", emoji: "⚡" },
    { to: "/blog/ai-repricer-behind-the-scenes", title: "AI Repricer Behind the Scenes", emoji: "🔍" },
    { to: "/blog/real-ai-decisions-live-asins", title: "Real AI Decisions from Live ASINs", emoji: "🎯" },
    { to: "/blog/what-ai-repricer-looks-at", title: "What an AI Repricer Looks At", emoji: "👁️" },
    { to: "/blog/product-library-amazon-sellers", title: "Product Library for Amazon Sellers", emoji: "📦" },
    { to: "/blog/what-repricer-does", title: "What a Repricer Actually Does", emoji: "🤖" },
    { to: "/blog/two-sellers-one-asin", title: "Two Sellers, One ASIN", emoji: "🤝" },
    { to: "/blog/arbitrage-vs-wholesale-repricing", title: "Arbitrage vs Wholesale Repricing", emoji: "⚖️" },
  ];

  return (
    <div className={`flex items-center ${spacingClass} text-sm`}>

      {!user && <ProductsMegaMenu />}

      {!user && (
        <Button
          variant="ghost"
          onClick={() => navigate('/pricing')}
          className="h-9 rounded-full border border-emerald-400/30 bg-gradient-to-r from-emerald-500/15 via-emerald-500/10 to-teal-500/10 px-4 backdrop-blur-sm hover:from-emerald-500/25 hover:via-emerald-500/20 hover:to-teal-500/20 hover:border-emerald-400/60 transition-all duration-200 group relative overflow-hidden"
        >
          <Tag className="mr-1.5 h-3.5 w-3.5 text-emerald-400 group-hover:scale-110 transition-transform" />
          <span className="font-bold text-emerald-300 text-xs tracking-wide uppercase">Pricing</span>
          <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-emerald-400/20 px-1.5 py-0.5 text-[9px] font-bold text-emerald-200 ring-1 ring-emerald-400/30">
            <Sparkles className="h-2.5 w-2.5" />
            60-DAY FREE
          </span>
        </Button>
      )}

      {!user && (
        <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="h-9 rounded-full border border-primary/30 bg-primary/10 px-4 backdrop-blur-sm hover:bg-primary/20 hover:border-primary/50 transition-all duration-200 group"
          >
            <BookOpen className="mr-1.5 h-3.5 w-3.5 text-primary group-hover:scale-110 transition-transform" />
            <span className="font-bold text-primary text-xs tracking-wide uppercase">Blog</span>
            <ChevronDown className="ml-1.5 h-3 w-3 text-primary/60 group-hover:text-primary transition-colors" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-80 p-2 bg-[hsl(222,84%,6%)] border border-white/10 backdrop-blur-xl shadow-2xl shadow-primary/10 rounded-xl"
        >
          <div className="px-3 py-2 mb-1">
            <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-primary/70">Latest Articles</p>
          </div>
          <DropdownMenuSeparator className="bg-white/5" />
          {blogItems.map((blog) => (
            <DropdownMenuItem
              key={blog.to}
              className="cursor-pointer rounded-lg px-3 py-2.5 my-0.5 focus:bg-primary/10 hover:bg-primary/10 transition-colors group/item"
              onClick={() => navigate(blog.to)}
            >
              <span className="mr-2.5 text-base">{blog.emoji}</span>
              <span className="text-sm font-medium text-white/80 group-hover/item:text-white transition-colors leading-snug">
                {blog.title}
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      )}

      {user && (
        <PlatformModulesMenu isAdmin={isAdmin} />
      )}

      {user && (
        <>
          <BbPriceAlerts />
          <HijackerAlerts />
          {isAdmin && (
            <>
              <AdminChatNotification />
              <AdminErrorNotification />
            </>
          )}
        </>
      )}

      <SalesSyncButton />

      {user ? (
        <UserMenu />
      ) : (
        <div className="ml-4 flex items-center gap-2">
          <Button 
            size="sm"
            onClick={() => navigate('/login')}
          >
            Log in
          </Button>
          <Button 
            size="sm"
            onClick={() => navigate('/signup')}
          >
            Sign up
          </Button>
        </div>
      )}
    </div>
  );
};

export default NavbarLinks;
