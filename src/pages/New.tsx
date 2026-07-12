
import { Helmet } from "react-helmet-async";
import { useInventoryHubTheme } from "@/hooks/use-inventoryhub-theme";
import NavbarThemed from "@/components/navbar/NavbarThemed";
import { useSubscription } from "@/hooks/use-subscription";
import HeroThemed from "@/components/HeroThemed";
import AiBannerThemed from "@/components/AiBannerThemed";
import ProductLibraryBannerThemed from "@/components/ProductLibraryBannerThemed";
import SalesDashboardBannerThemed from "@/components/SalesDashboardBannerThemed";
import SmartPricingSectionThemed from "@/components/SmartPricingSectionThemed";
import SafetySectionThemed from "@/components/SafetySectionThemed";
import ComparisonSectionThemed from "@/components/ComparisonSectionThemed";
import FinalCTAThemed from "@/components/FinalCTAThemed";
import ScrollIndicator from "@/components/ScrollIndicator";

// Working-title rebrand preview. Route is intentionally generic (/new) since
// the final brand name/domain isn't locked in yet — rename this route once it is.
//
// This is the full real homepage (IndexPageSections.tsx's render tree),
// re-themed for the "InventoryHub" light identity — not a simplified
// placeholder. Every section, stat, and word of copy is identical to the
// live dark /  homepage; only background/font/color classes changed, plus
// CTA buttons standardized to the single primary Button style used
// elsewhere in this theme. Reused UNMODIFIED where already token-driven:
// ScrollIndicator. Everything else needed a themed copy (see each
// `*Themed.tsx` file's header comment for what changed and why).
//
// Footer is intentionally omitted (same call as the other themed pages —
// that shared component is hardcoded-dark and would clash with the light
// page). Navbar is the real, themed, functional NavbarThemed.

const New = () => {
  useInventoryHubTheme();
  const { isAdmin } = useSubscription();

  return (
    <div className="theme-inventoryhub font-ih-sans min-h-screen bg-background text-foreground">
      <Helmet>
        <title>ArbiProSeller — InventoryHub theme preview</title>
        <meta name="robots" content="noindex, nofollow" />
        <meta
          name="description"
          content="Make better sourcing decisions. Price smarter with AI. Scale with confidence — ArbiProSeller helps you organize proven Amazon products, track suppliers, and automate pricing."
        />
      </Helmet>

      <NavbarThemed isAdmin={isAdmin} />

      <HeroThemed />
      <AiBannerThemed />
      <ProductLibraryBannerThemed />
      <SalesDashboardBannerThemed />
      <SmartPricingSectionThemed />
      <SafetySectionThemed />
      <ComparisonSectionThemed />
      <FinalCTAThemed />
      <ScrollIndicator />
    </div>
  );
};

export default New;
