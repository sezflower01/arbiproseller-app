import { useIsMobile } from "@/hooks/use-mobile";
import LiveChatWidget from "@/components/chat/LiveChatWidget";
import AdminRestockNotification from "@/components/repricer/AdminRestockNotification";

/**
 * Renders floating chat / restock notification widgets only on desktop.
 * On mobile (<768px) these are hidden to keep the screen clean and
 * focused on the mobile-first tools.
 *
 * AdminChatNotification and AdminErrorNotification used to render here
 * as fixed top-left overlays (top-4 left-4 / top-4 left-40), which sat
 * directly on top of the navbar logo. They've moved into NavbarLinks.tsx
 * as compact bell-icon triggers next to BbPriceAlerts/HijackerAlerts —
 * NavbarLinks is itself desktop-only (`hidden md:flex` in Navbar.tsx),
 * so they're still correctly hidden on mobile without needing this gate.
 */
export default function DesktopOnlyWidgets() {
  const isMobile = useIsMobile();
  if (isMobile) return null;
  return (
    <>
      <LiveChatWidget />
      <AdminRestockNotification />
    </>
  );
}
