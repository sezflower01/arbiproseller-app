import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, CheckCircle2, AlertCircle, Package, BarChart3, Bot } from "lucide-react";
import { useSyncStatus } from "@/hooks/use-sync-status";

// Light "InventoryHub" re-theme of SyncReadinessBanner.tsx — identical status
// logic. The original's text-blue-200/text-yellow-200 are unconditional (no
// dark: pairing), i.e. pastel shades tuned only for a dark backdrop — darkened
// here to -700/-800 shades for legibility on a light page.

interface SyncReadinessBannerThemedProps {
  module: "inventory" | "repricer" | "sales" | "pl";
}

export function SyncReadinessBannerThemed({ module }: SyncReadinessBannerThemedProps) {
  const { status, loading } = useSyncStatus();

  if (loading) return null;

  // Don't show if no Amazon connection tracked yet (legacy users)
  if (!status.amazon_connected) return null;

  if (module === "inventory") {
    if (status.inventory_synced) return null;
    if (status.inventory_sync_started_at) {
      return (
        <Alert className="mb-4 border-blue-500/30 bg-blue-500/10">
          <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
          <AlertDescription className="text-blue-800">
            <strong>Inventory sync in progress...</strong> Your full product catalog is being imported from Amazon. This usually takes 3-10 minutes.
          </AlertDescription>
        </Alert>
      );
    }
    return (
      <Alert className="mb-4 border-yellow-500/30 bg-yellow-500/10">
        <Package className="h-4 w-4 text-yellow-700" />
        <AlertDescription className="text-yellow-800">
          <strong>Inventory not yet synced.</strong> Your Amazon account is connected and your catalog will be imported automatically. This usually takes 3-10 minutes.
        </AlertDescription>
      </Alert>
    );
  }

  if (module === "repricer") {
    if (status.repricer_ready) return null;
    if (!status.inventory_synced) {
      return (
        <Alert className="mb-4 border-yellow-500/30 bg-yellow-500/10">
          <Loader2 className="h-4 w-4 animate-spin text-yellow-700" />
          <AlertDescription className="text-yellow-800">
            <strong>Waiting for inventory sync to complete...</strong> The repricer needs your product catalog before assignments can be created. This is happening automatically.
          </AlertDescription>
        </Alert>
      );
    }
    return (
      <Alert className="mb-4 border-blue-500/30 bg-blue-500/10">
        <Bot className="h-4 w-4 text-blue-600" />
        <AlertDescription className="text-blue-800">
          <strong>Inventory synced!</strong> You can now create repricer assignments and configure rules for your products.
        </AlertDescription>
      </Alert>
    );
  }

  if (module === "sales") {
    // History sync is now handled via the inline month-by-month panel.
    // Don't show stale "syncing" banners from onboarding.
    return null;
  }

  if (module === "pl") {
    if (status.pl_ready) return null;
    if (status.history_syncing) {
      return (
        <Alert className="mb-4 border-yellow-500/30 bg-yellow-500/10">
          <Loader2 className="h-4 w-4 animate-spin text-yellow-700" />
          <AlertDescription className="text-yellow-800">
            <strong>Historical data still syncing.</strong> Current month data may be available. Full P&L accuracy improves as more history is imported.
          </AlertDescription>
        </Alert>
      );
    }
    return null;
  }

  return null;
}
