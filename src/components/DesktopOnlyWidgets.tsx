import { useIsMobile } from "@/hooks/use-mobile";
import LiveChatWidget from "@/components/chat/LiveChatWidget";
import AdminChatNotification from "@/components/chat/AdminChatNotification";
import AdminErrorNotification from "@/components/chat/AdminErrorNotification";
import AdminRestockNotification from "@/components/repricer/AdminRestockNotification";

/**
 * Renders floating chat / system / restock notification widgets
 * only on desktop. On mobile (<768px) these are hidden to keep
 * the screen clean and focused on the mobile-first tools.
 */
export default function DesktopOnlyWidgets() {
  const isMobile = useIsMobile();
  if (isMobile) return null;
  return (
    <>
      <LiveChatWidget />
      <AdminChatNotification />
      <AdminErrorNotification />
      <AdminRestockNotification />
    </>
  );
}
