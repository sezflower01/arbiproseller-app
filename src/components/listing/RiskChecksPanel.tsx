import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ShieldAlert, ShieldCheck, AlertTriangle, Info } from "lucide-react";

interface RiskCheck {
  id: string;
  label: string;
  level: "HIGH" | "MEDIUM" | "LOW" | "PASS";
  detail: string;
  link?: string;
}

interface RiskChecksPanelProps {
  brand: string | null;
  isGenericBrand: boolean;
  gatingStatus?: string;
  validationPassed: boolean;
}

const levelConfig = {
  HIGH: { icon: ShieldAlert, color: "text-red-700", bg: "bg-red-50", border: "border-red-200", badge: "destructive" as const },
  MEDIUM: { icon: AlertTriangle, color: "text-yellow-700", bg: "bg-yellow-50", border: "border-yellow-200", badge: "outline" as const },
  LOW: { icon: Info, color: "text-blue-700", bg: "bg-blue-50", border: "border-blue-200", badge: "outline" as const },
  PASS: { icon: ShieldCheck, color: "text-green-700", bg: "bg-green-50", border: "border-green-200", badge: "secondary" as const },
};

const RiskChecksPanel = ({ brand, isGenericBrand, gatingStatus, validationPassed }: RiskChecksPanelProps) => {
  const checks: RiskCheck[] = [];

  // 1. Generic brand check
  if (isGenericBrand) {
    checks.push({
      id: "generic_brand",
      label: "Generic / Unbranded Product",
      level: "HIGH",
      detail: `Brand detected: "${brand}". Amazon blocks sellers from adding offers to another seller's generic product (Error 5886). You must create a new product listing instead.`,
      link: "https://sellercentral.amazon.com/help/hub/reference/G200270100",
    });
  } else if (brand) {
    checks.push({
      id: "generic_brand",
      label: "Brand Check",
      level: "PASS",
      detail: `Brand: "${brand}" — not flagged as generic.`,
    });
  } else {
    checks.push({
      id: "generic_brand",
      label: "Brand Unknown",
      level: "MEDIUM",
      detail: "Could not detect brand from Amazon catalog. If this is a generic/unbranded product, you may get Error 5886 after submission.",
    });
  }

  // 2. Gating / approval check
  if (gatingStatus === "RESTRICTED") {
    checks.push({
      id: "gating",
      label: "Category / Brand Gated",
      level: "HIGH",
      detail: "This product is restricted in your account. You need Amazon approval before listing.",
    });
  } else if (gatingStatus === "APPROVAL_REQUIRED") {
    checks.push({
      id: "gating",
      label: "Approval Required",
      level: "HIGH",
      detail: "Amazon requires approval to sell this product. Request approval in Seller Central first.",
    });
  } else if (gatingStatus === "APPROVED") {
    checks.push({
      id: "gating",
      label: "Selling Eligibility",
      level: "PASS",
      detail: "You are approved to sell this product.",
    });
  }

  // 3. Contributing to existing generic detail page
  if (isGenericBrand) {
    checks.push({
      id: "contribute_generic",
      label: "Contributing to Existing Generic Page",
      level: "HIGH",
      detail: "You appear to be adding an offer to an existing generic detail page — the most common trigger for Error 5886. Create a new product instead.",
    });
  }

  // 4. Schema validation summary
  if (validationPassed) {
    checks.push({
      id: "schema_validation",
      label: "Schema Validation",
      level: "PASS",
      detail: "Amazon's VALIDATION_PREVIEW passed — attributes and schema are valid.",
    });
  }

  const hasRisks = checks.some(c => c.level === "HIGH" || c.level === "MEDIUM");
  const highCount = checks.filter(c => c.level === "HIGH").length;
  const medCount = checks.filter(c => c.level === "MEDIUM").length;

  if (checks.length === 0) return null;

  return (
    <Card className={hasRisks ? "border-orange-300" : "border-green-200"}>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          {hasRisks ? (
            <ShieldAlert className="w-5 h-5 text-orange-600" />
          ) : (
            <ShieldCheck className="w-5 h-5 text-green-600" />
          )}
          Business Rule Risk Checks
          {highCount > 0 && (
            <Badge variant="destructive" className="ml-2 text-xs">{highCount} HIGH</Badge>
          )}
          {medCount > 0 && (
            <Badge variant="outline" className="ml-1 text-xs text-yellow-700 border-yellow-300">{medCount} MED</Badge>
          )}
        </CardTitle>
        {hasRisks && validationPassed && (
          <p className="text-xs text-orange-700 mt-1">
            ⚠ Validation passed, but risk checks found issues. "Schema valid" ≠ "safe to list."
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-2 pt-0">
        {checks.map((check) => {
          const config = levelConfig[check.level];
          const Icon = config.icon;
          return (
            <div key={check.id} className={`p-3 rounded-md border ${config.bg} ${config.border}`}>
              <div className="flex items-start gap-2">
                <Icon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${config.color}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`text-sm font-medium ${config.color}`}>{check.label}</span>
                    <Badge variant={config.badge} className="text-[10px] px-1.5 py-0">
                      {check.level}
                    </Badge>
                  </div>
                  <p className={`text-xs mt-1 ${config.color}`}>{check.detail}</p>
                  {check.link && (
                    <a
                      href={check.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs underline mt-1 inline-block"
                    >
                      Learn more →
                    </a>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
};

export default RiskChecksPanel;
