// Single source of truth for the categorized module navigation.
// Used by /tools (Tools Hub) and the navbar Platform Modules mega-dropdown.
import {
  AlertTriangle,
  BarChart3,
  Banknote,
  BoxIcon,
  Building2,
  Database,
  Calculator,
  DollarSign,
  FilePlus,
  FlaskConical,
  FolderTree,
  Globe,
  LayoutDashboard,
  LineChart,
  Link2,
  ListChecks,
  Package,
  Plug,
  Printer,
  Receipt,
  RefreshCw,
  Search,
  ScanLine,
  ShieldAlert,
  ShieldCheck,
  Store,
  Tags,
  Target,
  TrendingUp,
  Truck,
  Users,
  Warehouse,
  type LucideIcon,
} from "lucide-react";

export type ModuleBadge = "free" | "subscribe" | "admin-live" | "admin" | "soon";

export type ModuleItem = {
  /** Internal route. If undefined the item is "coming soon". */
  path?: string;
  label: string;
  description: string;
  icon: LucideIcon;
  /** Tailwind gradient classes used for the icon tile background. */
  color: string;
  badges?: ModuleBadge[];
  /** Hide unless the user has admin role. */
  adminOnly?: boolean;
  /** GA event name for click tracking. */
  ga?: string;
  /** If set, clicking the card downloads this file (relative public URL) instead of navigating. */
  downloadUrl?: string;
  /** Filename to save the downloaded file as. */
  downloadFilename?: string;
};

export type ModuleCategory = {
  id: string;
  label: string;
  /** Short tagline shown under the category title. */
  tagline: string;
  /** Single emoji used in compact menus / breadcrumbs. */
  emoji: string;
  icon: LucideIcon;
  /** Tailwind gradient for the category accent. */
  accent: string;
  /** Featured categories get a brighter, slightly larger card treatment. */
  featured?: boolean;
  modules: ModuleItem[];
};

export const MODULE_CATEGORIES: ModuleCategory[] = [
  {
    id: "dashboard",
    label: "Dashboard",
    tagline: "Overview & quick stats",
    emoji: "🏠",
    icon: LayoutDashboard,
    accent: "from-slate-500 to-slate-700",
    modules: [
      {
        path: "/tools/dashboard",
        label: "Overview",
        description: "Live business snapshot: profit, inventory, repricing, shipments and alerts.",
        icon: LayoutDashboard,
        color: "from-slate-500 to-slate-700",
        ga: "tool_menu_dashboard",
      },
    ],
  },
  {
    id: "inventory",
    label: "Inventory",
    tagline: "Stock, value, corrections",
    emoji: "📦",
    icon: Warehouse,
    accent: "from-orange-500 to-amber-600",
    modules: [
      {
        path: "/tools/synced-inventory",
        label: "Inventory Valuation",
        description: "Real-time inventory valuation & sync with Amazon FBA.",
        icon: Warehouse,
        color: "from-orange-500 to-amber-600",
        badges: ["free"],
        ga: "tool_menu_synced_inventory",
      },
      {
        path: "/tools/inventory-writeoff",
        label: "Inventory Write-Off",
        description: "Record warehouse losses (restricted, dead, expired). Flows into P&L as Business Loss.",
        icon: AlertTriangle,
        color: "from-rose-500 to-red-600",
        ga: "tool_menu_inventory_writeoff",
      },
      {
        path: "/tools/disposition-management",
        label: "Disposition Management",
        description: "Review removals, disposals & liquidations. Tracks unsellable losses fed into your P&L.",
        icon: AlertTriangle,
        color: "from-red-500 to-orange-600",
        ga: "tool_menu_disposition_management",
      },
      {
        path: "/tools/created-listings",
        label: "Product Library",
        description: "Saved product catalog with supplier links, search & quick reorder.",
        icon: ListChecks,
        color: "from-teal-500 to-cyan-600",
        badges: [],
        ga: "tool_menu_created_listings",
      },
      {
        path: "/tools/still-thinking",
        label: "Still Thinking",
        description: "Saved-for-later products from the extension. Convert to a real listing when you're ready to buy.",
        icon: ListChecks,
        color: "from-violet-500 to-purple-600",
        ga: "tool_menu_still_thinking",
      },
      {
        path: "/tools/fba-eligibility-issues",
        label: "FBA Eligibility Issues",
        description:
          "Review ASINs blocked from FBA because of manufacturer barcode, missing FNSKU, or listing restrictions.",
        icon: ShieldAlert,
        color: "from-red-500 to-rose-600",
        ga: "tool_menu_fba_eligibility_issues",
      },
    ],
  },
  {
    id: "finance",
    label: "Finance & Accounting",
    tagline: "Taxes, profit, expenses",
    emoji: "💰",
    icon: DollarSign,
    accent: "from-emerald-500 to-green-600",
    modules: [
      {
        path: "/tools/profit-loss",
        label: "Profit & Loss",
        description: "Comprehensive P&L statements and financial insights.",
        icon: BarChart3,
        color: "from-violet-500 to-purple-600",
        adminOnly: false,
        ga: "tool_menu_profit_loss",
      },
      {
        path: "/tools/sales",
        label: "Sales Report",
        description: "Track daily sales, refunds, and revenue analytics.",
        icon: DollarSign,
        color: "from-blue-500 to-indigo-600",
        adminOnly: true,
        ga: "tool_menu_sales",
      },
      {
        path: "/tools/settlement",
        label: "Settlement",
        description: "View Amazon settlement reports.",
        icon: Banknote,
        color: "from-lime-500 to-green-600",
        adminOnly: false,
        ga: "tool_menu_settlement",
      },
      {
        path: "/tools/reimbursements",
        label: "Reimbursements",
        description: "Track FBA reimbursement claims.",
        icon: AlertTriangle,
        color: "from-red-500 to-rose-600",
        adminOnly: true,
        ga: "tool_menu_reimbursements",
      },
      {
        path: "/tools/expenses",
        label: "My Expenses",
        description: "Track business expenses for tax reporting.",
        icon: Receipt,
        color: "from-yellow-500 to-amber-600",
        adminOnly: false,
        ga: "tool_menu_expenses",
      },
    ],
  },
  {
    id: "logistics",
    label: "Shipments & Logistics",
    tagline: "Send, track, label",
    emoji: "🚚",
    icon: Truck,
    accent: "from-sky-500 to-blue-600",
    modules: [
      {
        path: "/tools/shipment-builder",
        label: "FBA Shipment Builder",
        description: "Create and manage FBA shipments.",
        icon: BoxIcon,
        color: "from-sky-500 to-blue-600",
        adminOnly: false,
        ga: "tool_menu_shipment_builder",
      },
      {
        path: "/tools/purchase-vs-shipment",
        label: "Purchase vs Shipment Report",
        description: "Compare units ordered, received, and shipped per ASIN.",
        icon: BoxIcon,
        color: "from-indigo-500 to-blue-600",
        adminOnly: false,
        ga: "tool_menu_purchase_vs_shipment",
      },
      {
        path: "/tools/shipment-tracking",
        label: "Shipment Tracking",
        description: "Track your FBA shipment status.",
        icon: Truck,
        color: "from-slate-500 to-gray-600",
        adminOnly: false,
        ga: "tool_menu_shipment_tracking",
      },
      {
        path: "/tools/label-printing",
        label: "Label Printing",
        description: "Print FNSKU and shipping labels easily.",
        icon: Printer,
        color: "from-pink-500 to-rose-600",
        adminOnly: false,
        ga: "tool_menu_label_printing",
      },
      {
        path: "/tools/printing-without-pdf",
        label: "Print Without PDF",
        description: "Direct thermal printing without PDF files.",
        icon: Package,
        color: "from-fuchsia-500 to-pink-600",
        adminOnly: true,
        ga: "tool_menu_printing_without_pdf",
      },
      {
        path: "/tools/tracking",
        label: "Worldwide Tracking",
        description: "Track packages from any carrier globally.",
        icon: Globe,
        color: "from-cyan-500 to-teal-600",
        badges: ["free"],
        adminOnly: true,
        ga: "tool_menu_tracking",
      },
    ],
  },
  {
    id: "repricing",
    label: "Repricing & Pricing",
    tagline: "Price, compete, track",
    emoji: "🔁",
    icon: Tags,
    accent: "from-rose-500 to-red-600",
    modules: [
      {
        path: "/tools/repricer",
        label: "Repricer",
        description: "Automatically adjust prices using advanced repricing logic.",
        icon: Tags,
        color: "from-rose-500 to-red-600",
        ga: "tool_menu_repricer",
      },
      {
        path: "/tools/fetch-listing-price",
        label: "Fetch Listing Price",
        description: "Compare listing prices across US, CA, MX, BR.",
        icon: Search,
        color: "from-blue-500 to-cyan-600",
        adminOnly: true,
        ga: "tool_menu_fetch_listing_price",
      },
      {
        path: "/tools/price-history",
        label: "Price History",
        description: "Track ASIN price changes over time with charts.",
        icon: LineChart,
        color: "from-purple-500 to-indigo-600",
        adminOnly: true,
        ga: "tool_menu_price_history",
      },
    ],
  },
  {
    id: "sourcing",
    label: "Sourcing & Product Research",
    tagline: "Where the money is made",
    emoji: "🔍",
    icon: Search,
    accent: "from-violet-500 to-fuchsia-500",
    featured: true,
    modules: [
      {
        path: "/tools/product-finder",
        label: "Product Finder",
        description: "Search Amazon products with Keepa filters for OA & wholesale sourcing.",
        icon: Search,
        color: "from-violet-500 to-fuchsia-600",
        adminOnly: true,
        ga: "tool_menu_product_finder",
      },
      {
        path: "/tools/sourcer",
        label: "Sourcer",
        description: "Scout ASINs/UPCs/keywords with live offers, profit calculator, sales history & price trend.",
        icon: Target,
        color: "from-indigo-500 to-purple-600",
        adminOnly: true,
        ga: "tool_menu_sourcer",
      },
      {
        path: "/tools/scan-history",
        label: "Scan History",
        description: "Every UPC/EAN you scanned from the mobile scanner — with ASIN, price & profit.",
        icon: ScanLine,
        color: "from-blue-500 to-cyan-600",
        ga: "tool_menu_scan_history",
      },
      {
        path: "/tools/replenish-search",
        label: "Replenish Search",
        description: "Find products to replenish stock.",
        icon: RefreshCw,
        color: "from-purple-500 to-violet-600",
        adminOnly: true,
        ga: "tool_menu_replenish_search",
      },
      {
        path: "/tools/need-buy-again",
        label: "Need to Buy Again",
        description: "Profitable past purchases worth restocking based on sales velocity.",
        icon: RefreshCw,
        color: "from-pink-500 to-rose-600",
        ga: "tool_menu_need_buy_again",
      },
      {
        path: "/tools/research-leads",
        label: "Research Leads",
        description: "Private research database — log past FBA Lead List ASINs & retail links. Isolated from your live library.",
        icon: FlaskConical,
        color: "from-violet-500 to-fuchsia-600",
        ga: "tool_menu_research_leads",
      },
      {
        path: "/tools/google-product-search",
        label: "Google Product Search",
        description: "Search Google Shopping by ASIN for images and prices.",
        icon: Search,
        color: "from-emerald-500 to-teal-600",
        adminOnly: true,
        ga: "tool_menu_google_product_search",
      },
      {
        path: "/tools/user-store-scan",
        label: "Store Scan",
        description: "Browse pre-scanned profitable supplier-to-Amazon matches. No API credits used.",
        icon: Store,
        color: "from-emerald-500 to-green-600",
        badges: ["free"],
        adminOnly: true,
        ga: "tool_menu_user_store_scan",
      },
      {
        path: "/tools/user-supplier-discovery",
        label: "Supplier Discovery",
        description: "Look up supplier candidates already discovered for any ASIN. No API credits used.",
        icon: Search,
        color: "from-cyan-500 to-blue-600",
        badges: ["free"],
        adminOnly: true,
        ga: "tool_menu_user_supplier_discovery",
      },
    ],
  },
  {
    id: "supplier-intel",
    label: "Supplier Intelligence",
    tagline: "Advanced AI sourcing layer",
    emoji: "🧠",
    icon: Building2,
    accent: "from-orange-500 to-red-600",
    modules: [
      {
        path: "/tools/supplier-discovery",
        label: "Supplier Discovery (Live)",
        description: "Find retail source candidates for an ASIN — auto-ranked, auto-extracted prices.",
        icon: Search,
        color: "from-orange-500 to-red-600",
        badges: ["admin-live"],
        adminOnly: true,
        ga: "tool_menu_supplier_discovery",
      },
      {
        path: "/tools/price-extractor",
        label: "Price Extractor",
        description: "Universal product price extractor — pulls price, currency, image and title from any URL.",
        icon: Link2,
        color: "from-amber-500 to-orange-600",
        badges: ["admin-live"],
        adminOnly: true,
        ga: "tool_menu_price_extractor",
      },
      {
        path: "/tools/scan-categories",
        label: "Scan Categories",
        description: "Curate named categories (e.g. Books) with supplier URLs that users can browse.",
        icon: FolderTree,
        color: "from-violet-500 to-purple-600",
        badges: ["admin-live"],
        adminOnly: true,
        ga: "tool_menu_scan_categories",
      },
    ],
  },
  {
    id: "calculators",
    label: "Tools & Calculators",
    tagline: "Quick math utilities",
    emoji: "🧮",
    icon: Calculator,
    accent: "from-emerald-500 to-green-600",
    modules: [
      {
        path: "/tools/roi",
        label: "ROI Calculator",
        description: "Calculate profit margins and return on investment.",
        icon: TrendingUp,
        color: "from-emerald-500 to-green-600",
        badges: ["free"],
        adminOnly: true,
        ga: "tool_menu_roi",
      },
      {
        path: "/tools/target-roi-price",
        label: "Target ROI Price",
        description: "Calculate required selling price for target ROI across currencies.",
        icon: Target,
        color: "from-amber-500 to-yellow-600",
        adminOnly: true,
        ga: "tool_menu_target_roi_price",
      },
    ],
  },
  {
    id: "admin",
    label: "Admin & Settings",
    tagline: "Restricted access",
    emoji: "⚙️",
    icon: ShieldCheck,
    accent: "from-rose-500 to-pink-600",
    modules: [
      {
        path: "/tools/admin-users",
        label: "User Management",
        description: "Assign roles and control module access for every user.",
        icon: Users,
        color: "from-rose-500 to-pink-600",
        badges: ["admin"],
        adminOnly: true,
        ga: "tool_menu_admin_users",
      },
      {
        path: "/tools/admin-management",
        label: "Admin Management",
        description: "Manage admin profiles, names, and avatars.",
        icon: ShieldCheck,
        color: "from-violet-500 to-purple-600",
        badges: ["admin"],
        adminOnly: true,
        ga: "tool_menu_admin_management",
      },
      {
        path: "/tools/amazon-connection",
        label: "Amazon SP-API Connection",
        description: "Manage encrypted LWA credentials and test the Amazon connection.",
        icon: Plug,
        color: "from-amber-500 to-orange-600",
        badges: ["admin"],
        adminOnly: true,
        ga: "tool_menu_amazon_connection",
      },
      {
        label: "Chrome Extension — Amazon Analyzer",
        description:
          "Floating ASIN scanner for Amazon pages: Buy Box, ROI, sellers, Keepa stability. Click to download the .zip.",
        icon: ScanLine,
        color: "from-blue-500 to-indigo-600",
        badges: ["admin"],
        adminOnly: true,
        ga: "tool_menu_extension_analyzer",
        downloadUrl: "/arbiproseller-extension.zip",
        downloadFilename: "arbiproseller-extension.zip",
      },
      {
        label: "Chrome Extension — Create Listing",
        description:
          "Floating Create Listing form on Amazon pages: fetch product, validate, create on Amazon, save to Product Library.",
        icon: FilePlus,
        color: "from-emerald-500 to-teal-600",
        badges: ["admin"],
        adminOnly: true,
        ga: "tool_menu_extension_create_listing",
        downloadUrl: "/arbiproseller-create-listing-extension.zip",
        downloadFilename: "arbiproseller-create-listing-extension.zip",
      },
      {
        path: "/tools/database-maintenance",
        label: "Database Maintenance",
        description: "Cleanup retention, health alerts, performance snapshot, and VACUUM controls.",
        icon: Database,
        color: "from-cyan-500 to-blue-600",
        badges: ["admin"],
        adminOnly: true,
        ga: "tool_menu_database_maintenance",
      },
    ],
  },
];

export const visibleModules = (
  category: ModuleCategory,
  isAdmin: boolean,
): ModuleItem[] => category.modules.filter((m) => !m.adminOnly || isAdmin);

export const visibleCategories = (isAdmin: boolean): ModuleCategory[] =>
  MODULE_CATEGORIES.map((c) => ({ ...c, modules: visibleModules(c, isAdmin) })).filter(
    (c) => c.modules.length > 0,
  );
