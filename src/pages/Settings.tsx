import { useState } from "react";
import { User, Building2, HeadphonesIcon, CreditCard, Link2, Receipt, Zap, Rocket, Mail, Printer, PackageCheck } from "lucide-react";
import { useNavigate } from "react-router-dom";
import Navbar from "@/components/Navbar";
import ProfileSettings from "@/components/settings/ProfileSettings";
import OrganizationSettings from "@/components/settings/OrganizationSettings";
import SupportSettings from "@/components/settings/SupportSettings";
import BillingSettings from "@/components/settings/BillingSettings";
import ManagedListingsSettings from "@/components/settings/ManagedListingsSettings";
import GettingStartedSettings from "@/components/settings/GettingStartedSettings";
import ConnectPrinterSettings from "@/components/settings/ConnectPrinterSettings";
import ShipmentPreferencesSettings from "@/components/settings/ShipmentPreferencesSettings";
import ChoosePlanDialog from "@/components/subscription/ChoosePlanDialog";
import { useSubscription } from "@/hooks/use-subscription";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const TABS = [
  { id: "getting-started", label: "4 Simple Steps", icon: Rocket },
  { id: "profile", label: "Users", icon: User },
  { id: "organization", label: "Organization", icon: Building2 },
  { id: "billing", label: "Billing & Invoices", icon: Receipt },
  { id: "managed-listings", label: "Repricer Slots", icon: Zap },
  { id: "subscriptions", label: "Subscribe", icon: CreditCard, action: "subscribe" as const },
  { id: "amazon", label: "Connect Amazon", icon: Link2, route: "/tools/amazon-connect" },
  { id: "connect-printer", label: "Connect Printer", icon: Printer },
  { id: "shipment-preferences", label: "Shipment Preferences", icon: PackageCheck },
  { id: "email-center", label: "Email Center", icon: Mail, route: "/tools/email-center" },
  { id: "support", label: "Support", icon: HeadphonesIcon },
] as const;

type TabId = typeof TABS[number]["id"];

export default function Settings() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<TabId>("getting-started");
  const [planDialogOpen, setPlanDialogOpen] = useState(false);
  const {
    activeListings,
    effectivePlan,
    marketplaceCounts,
    listingsLoading: subLoading,
  } = useSubscription();
  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-br from-[hsl(222,84%,4.9%)] via-[hsl(230,50%,10%)] to-[hsl(260,50%,8%)] relative overflow-hidden">
      <div className="absolute top-1/4 -left-32 w-96 h-96 bg-primary/20 rounded-full blur-[120px] animate-pulse" />
      <div className="absolute bottom-1/4 -right-32 w-96 h-96 bg-purple-500/15 rounded-full blur-[120px] animate-pulse" style={{ animationDelay: "1s" }} />
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-primary/5 rounded-full blur-[200px]" />
      <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:64px_64px]" />

      <Navbar />

      <div className="container mx-auto px-4 py-8 max-w-5xl relative z-10 pt-24">
        <h1 className="text-2xl font-bold text-white mb-8">Account Settings</h1>

        <div className="flex gap-8">
          {/* Sidebar */}
          <nav className="w-52 shrink-0 space-y-1">
            {TABS.map((t) => {
              const Icon = t.icon;
              return (
                <button
                  key={t.id}
                  onClick={() => {
                    if ('action' in t && t.action === 'subscribe') {
                      setPlanDialogOpen(true);
                    } else if ('route' in t && t.route) {
                      navigate(t.route);
                    } else {
                      setTab(t.id);
                    }
                  }}
                  className={cn(
                    "w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors text-left",
                    tab === t.id
                      ? "bg-primary/15 text-primary"
                      : "text-gray-400 hover:text-white hover:bg-white/5"
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {t.label}
                  {t.id === "managed-listings" && (
                    <Badge variant="outline" className={`ml-auto text-[10px] px-1.5 py-0 ${subLoading || !effectivePlan ? "text-muted-foreground border-muted-foreground/40" : activeListings > (effectivePlan.listing_limit || 2000) ? "text-destructive border-destructive/40" : "text-primary border-primary/40"}`}>
                      {subLoading || !effectivePlan ? "…" : `${activeListings.toLocaleString()} / ${(effectivePlan.listing_limit || 2000).toLocaleString()}`}
                    </Badge>
                  )}
                </button>
              );
            })}
          </nav>

          {/* Content */}
          <div className="flex-1 min-w-0">
            {tab === "getting-started" && <GettingStartedSettings />}
            {tab === "profile" && <ProfileSettings />}
            {tab === "organization" && <OrganizationSettings />}
            {tab === "billing" && <BillingSettings />}
            {tab === "managed-listings" && (
              <ManagedListingsSettings
                activeListings={activeListings}
                effectivePlan={effectivePlan}
                marketplaceCounts={marketplaceCounts}
                loading={subLoading}
              />
            )}
            {tab === "connect-printer" && <ConnectPrinterSettings />}
            {tab === "shipment-preferences" && <ShipmentPreferencesSettings />}
            {tab === "support" && <SupportSettings />}
          </div>
        </div>
      </div>
      <ChoosePlanDialog open={planDialogOpen} onOpenChange={setPlanDialogOpen} />
    </div>
  );
}
