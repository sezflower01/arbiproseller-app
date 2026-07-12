import { useEffect } from "react";

/**
 * Radix Popover/DropdownMenu content portals to document.body by default —
 * outside any wrapper div's DOM subtree. CSS custom property inheritance is
 * DOM-based, so a `.theme-inventoryhub` class on a page-level wrapper div
 * never reaches that portaled content, regardless of React tree nesting.
 *
 * Fix: toggle the class on <html> itself for the lifetime of the themed page.
 * Portaled nodes still land somewhere under <html>, so they inherit correctly.
 * Removed on unmount so the rest of the (dark) app is unaffected.
 */
export function useInventoryHubTheme() {
  useEffect(() => {
    document.documentElement.classList.add("theme-inventoryhub");
    return () => {
      document.documentElement.classList.remove("theme-inventoryhub");
    };
  }, []);
}
