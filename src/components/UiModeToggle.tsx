import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useUiMode } from "@/contexts/UiModeContext";
import { Settings2, Sparkles } from "lucide-react";

/**
 * Header pill that toggles between Simple Mode and Advanced Mode.
 * Persists preference in profiles.ui_mode.
 */
export default function UiModeToggle({ compact = false }: { compact?: boolean }) {
  const { mode, setMode, loading } = useUiMode();
  if (loading) return null;

  if (compact) {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={() => setMode(mode === "simple" ? "advanced" : "simple")}
        className="h-7 gap-1.5 text-xs"
        title={mode === "simple" ? "Switch to Advanced Mode" : "Switch to Simple Mode"}
      >
        {mode === "simple" ? <Sparkles className="h-3.5 w-3.5" /> : <Settings2 className="h-3.5 w-3.5" />}
        {mode === "simple" ? "Simple" : "Advanced"}
      </Button>
    );
  }

  return (
    <Card className="bg-card/60 border-primary/20">
      <CardContent className="p-3 flex items-center justify-between gap-4">
        <div className="text-sm">
          <span className="text-muted-foreground">View:</span>{" "}
          <strong className="text-foreground">{mode === "simple" ? "Simple Mode" : "Advanced Mode"}</strong>
          <span className="text-muted-foreground ml-2 text-xs hidden md:inline">
            {mode === "simple"
              ? "Business-focused — only what needs your attention."
              : "Engineering view — all diagnostics and internals."}
          </span>
        </div>
        <div className="flex gap-1">
          <Button
            size="sm"
            variant={mode === "simple" ? "default" : "outline"}
            onClick={() => setMode("simple")}
            className="h-7 text-xs"
          >
            <Sparkles className="h-3 w-3 mr-1" />
            Simple
          </Button>
          <Button
            size="sm"
            variant={mode === "advanced" ? "default" : "outline"}
            onClick={() => setMode("advanced")}
            className="h-7 text-xs"
          >
            <Settings2 className="h-3 w-3 mr-1" />
            Advanced
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
