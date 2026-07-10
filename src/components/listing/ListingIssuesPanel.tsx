import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, AlertCircle, Info, Search, Copy, CheckCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface ListingIssue {
  code?: string;
  message?: string;
  severity?: string;
  attributeNames?: string[];
  categories?: string[];
  enforcements?: any;
}

interface ListingIssuesPanelProps {
  issues: ListingIssue[];
  status?: string;
  mode?: string;
}

const severityConfig: Record<string, { icon: React.ElementType; color: string; bg: string; border: string; label: string }> = {
  ERROR: { icon: AlertCircle, color: "text-red-700", bg: "bg-red-50", border: "border-red-200", label: "Error" },
  WARNING: { icon: AlertTriangle, color: "text-yellow-700", bg: "bg-yellow-50", border: "border-yellow-200", label: "Warning" },
  INFO: { icon: Info, color: "text-blue-700", bg: "bg-blue-50", border: "border-blue-200", label: "Info" },
};

const ListingIssuesPanel = ({ issues, status, mode }: ListingIssuesPanelProps) => {
  const [search, setSearch] = useState("");
  const { toast } = useToast();

  if (!issues || issues.length === 0) {
    if (status === 'ACCEPTED' || (mode === 'VALIDATION_PREVIEW' && !status)) {
      return (
        <Card className="border-green-200 bg-green-50">
          <CardContent className="py-4 flex items-center gap-2 text-green-700">
            <CheckCircle className="w-5 h-5" />
            <span className="font-medium">
              {mode === 'VALIDATION_PREVIEW' ? 'Validation passed — no issues found!' : 'Listing accepted by Amazon!'}
            </span>
          </CardContent>
        </Card>
      );
    }
    return null;
  }

  const filtered = issues.filter((issue) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      (issue.code?.toLowerCase().includes(q)) ||
      (issue.message?.toLowerCase().includes(q)) ||
      (issue.severity?.toLowerCase().includes(q)) ||
      (issue.attributeNames?.some(a => a.toLowerCase().includes(q)))
    );
  });

  // Group by severity
  const grouped: Record<string, ListingIssue[]> = {};
  for (const issue of filtered) {
    const sev = issue.severity || 'INFO';
    if (!grouped[sev]) grouped[sev] = [];
    grouped[sev].push(issue);
  }

  const severityOrder = ['ERROR', 'WARNING', 'INFO'];
  const hasErrors = issues.some(i => i.severity === 'ERROR');

  const copyDetails = () => {
    navigator.clipboard.writeText(JSON.stringify(issues, null, 2));
    toast({ title: "Copied", description: "Issue details copied to clipboard" });
  };

  return (
    <Card className={`${hasErrors ? 'border-red-300' : 'border-yellow-300'}`}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            {hasErrors ? (
              <AlertCircle className="w-5 h-5 text-red-600" />
            ) : (
              <AlertTriangle className="w-5 h-5 text-yellow-600" />
            )}
            Amazon {mode === 'VALIDATION_PREVIEW' ? 'Validation' : 'Listing'} Issues ({issues.length})
          </CardTitle>
          <Button variant="outline" size="sm" onClick={copyDetails}>
            <Copy className="w-3 h-3 mr-1" /> Copy details
          </Button>
        </div>
        <div className="relative mt-2">
          <Search className="absolute left-2 top-2.5 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search issues (e.g. BRAND, condition)..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 h-9"
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        {severityOrder.map((sev) => {
          const items = grouped[sev];
          if (!items || items.length === 0) return null;
          const config = severityConfig[sev] || severityConfig.INFO;
          const Icon = config.icon;

          return (
            <div key={sev} className="space-y-2">
              <div className="flex items-center gap-1.5">
                <Icon className={`w-4 h-4 ${config.color}`} />
                <span className={`text-xs font-semibold uppercase ${config.color}`}>
                  {config.label} ({items.length})
                </span>
              </div>
              {items.map((issue, idx) => (
                <div key={idx} className={`p-3 rounded-md border ${config.bg} ${config.border}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      {issue.code && (
                        <Badge variant="outline" className="text-xs font-mono mb-1">
                          {issue.code}
                        </Badge>
                      )}
                      <p className={`text-sm ${config.color}`}>
                        {issue.message || 'No message provided'}
                      </p>
                      {issue.attributeNames && issue.attributeNames.length > 0 && (
                        <p className="text-xs text-muted-foreground mt-1">
                          Attributes: {issue.attributeNames.join(', ')}
                        </p>
                      )}
                      {issue.categories && issue.categories.length > 0 && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Categories: {issue.categories.join(', ')}
                        </p>
                      )}
                      {issue.enforcements && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Enforcements: {JSON.stringify(issue.enforcements)}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          );
        })}
        {filtered.length === 0 && search && (
          <p className="text-sm text-muted-foreground text-center py-2">
            No issues match "{search}"
          </p>
        )}
      </CardContent>
    </Card>
  );
};

export default ListingIssuesPanel;
