import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import PlatformModulesMenuThemed from "./PlatformModulesMenuThemed";
import UserMenuThemed from "./UserMenuThemed";
import BbPriceAlerts from "./BbPriceAlerts";
import HijackerAlerts from "./HijackerAlerts";

// Light "InventoryHub" navbar for the themed page family (/new, /new/tools, ...).
// Reuses BbPriceAlerts/HijackerAlerts as-is (already token-driven — their
// PopoverContent falls back to the default bg-popover/text-popover-foreground,
// which re-skins correctly under .theme-inventoryhub). Platform Modules menu
// and the user menu needed dedicated re-themed copies since the originals
// hardcode dark literals throughout, including their portaled dropdown panels.
//
// Scope note: mobile (<md) intentionally shows just the logo + a compact
// sign-in/account affordance, not a full themed clone of NavbarMobileMenu —
// that component is a large marketing-nav drawer (blog, download, buy-license)
// not relevant to the signed-in tools context this navbar serves.

interface NavbarThemedProps {
  isAdmin: boolean;
}

const NavbarThemed = ({ isAdmin }: NavbarThemedProps) => {
  const { user } = useAuth();
  const navigate = useNavigate();

  return (
    <nav className="fixed top-0 w-full z-40 bg-background/90 backdrop-blur-md border-b border-border">
      <div className="container mx-auto flex items-center h-16 px-4">
        <Link to="/new" className="flex items-center gap-2.5 shrink-0">
          <img src="/logo-icon.png" alt="InventoryHub Logo" className="h-8 w-auto" />
          <span className="font-ih-display text-xl font-bold text-primary">InventoryHub</span>
        </Link>

        <div className="hidden md:flex items-center gap-2 ml-6">
          {user && <PlatformModulesMenuThemed isAdmin={isAdmin} />}
        </div>

        <div className="hidden md:flex items-center gap-1 ml-auto">
          {user && (
            <>
              <BbPriceAlerts />
              <HijackerAlerts />
              <UserMenuThemed />
            </>
          )}
          {!user && (
            <>
              <Button size="sm" variant="ghost" onClick={() => navigate("/login")}>
                Log in
              </Button>
              <Button size="sm" onClick={() => navigate("/signup")}>
                Sign up
              </Button>
            </>
          )}
        </div>

        {/* Mobile: compact fallback — logo above already visible, just account access here */}
        <div className="md:hidden flex items-center ml-auto">
          {user ? (
            <UserMenuThemed />
          ) : (
            <Button size="sm" onClick={() => navigate("/login")}>
              Log in
            </Button>
          )}
        </div>
      </div>
    </nav>
  );
};

export default NavbarThemed;
