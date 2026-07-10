import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import { Brain, Zap, Settings2 } from "lucide-react";

export type EvalMode = "auto" | "force_smart" | "force_basic";
export type ActiveEvalMode = "smart" | "basic";

interface EvalModeBadgeProps {
  assignmentId: string | null;
  evalMode: EvalMode;
  activeEvalMode: ActiveEvalMode;
  evalModeReason: string | null;
  onUpdate: (evalMode: EvalMode) => void;
}

const MODE_CONFIG: Record<EvalMode, { label: string; icon: typeof Brain; className: string }> = {
  auto: {
    label: "Auto",
    icon: Settings2,
    className: "border-muted-foreground/40 text-muted-foreground bg-muted/30",
  },
  force_smart: {
    label: "Smart",
    icon: Brain,
    className: "border-violet-500 text-violet-600 dark:text-violet-400 bg-violet-50 dark:bg-violet-950/30",
  },
  force_basic: {
    label: "Basic",
    icon: Zap,
    className: "border-amber-500 text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30",
  },
};

const ACTIVE_CONFIG: Record<ActiveEvalMode, { emoji: string; label: string }> = {
  smart: { emoji: "🧠", label: "Smart" },
  basic: { emoji: "⚡", label: "Basic" },
};

export default function EvalModeBadge({
  assignmentId,
  evalMode,
  activeEvalMode,
  evalModeReason,
  onUpdate,
}: EvalModeBadgeProps) {
  const [updating, setUpdating] = useState(false);

  const handleChange = async (newMode: EvalMode) => {
    if (!assignmentId || newMode === evalMode) return;
    setUpdating(true);
    try {
      const { error } = await (supabase as any)
        .from("repricer_assignments")
        .update({
          eval_mode: newMode,
          active_eval_mode: newMode === "force_smart" ? "smart" : newMode === "force_basic" ? "basic" : activeEvalMode,
          eval_mode_reason: newMode === "auto" ? "user_set_auto" : `user_forced_${newMode.replace("force_", "")}`,
          eval_mode_switched_at: new Date().toISOString(),
        })
        .eq("id", assignmentId);

      if (error) throw error;
      onUpdate(newMode);
      toast.success(`Eval mode set to ${MODE_CONFIG[newMode].label}`);
    } catch {
      toast.error("Failed to update eval mode");
    } finally {
      setUpdating(false);
    }
  };

  const config = MODE_CONFIG[evalMode] || MODE_CONFIG.auto;
  const active = ACTIVE_CONFIG[activeEvalMode] || ACTIVE_CONFIG.smart;
  const Icon = config.icon;

  const tooltipText = evalMode === "auto"
    ? `Auto mode → currently ${active.label}${evalModeReason ? ` (${evalModeReason})` : ""}`
    : `Forced ${config.label} mode${evalModeReason ? ` — ${evalModeReason}` : ""}`;

  if (!assignmentId) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={updating}>
        <Badge
          variant="outline"
          className={`text-[9px] px-1.5 py-0 shrink-0 cursor-pointer hover:opacity-80 transition-opacity ${config.className}`}
          title={tooltipText}
        >
          <Icon className="h-2.5 w-2.5 mr-0.5" />
          {evalMode === "auto" ? `${active.emoji} Auto` : config.label}
        </Badge>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44">
        <DropdownMenuItem
          onClick={() => handleChange("auto")}
          className="text-xs gap-2"
        >
          <Settings2 className="h-3 w-3" />
          Auto (Recommended)
          {evalMode === "auto" && <span className="ml-auto text-[10px]">✓</span>}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => handleChange("force_smart")}
          className="text-xs gap-2"
        >
          <Brain className="h-3 w-3 text-violet-500" />
          Force Smart
          {evalMode === "force_smart" && <span className="ml-auto text-[10px]">✓</span>}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => handleChange("force_basic")}
          className="text-xs gap-2"
        >
          <Zap className="h-3 w-3 text-amber-500" />
          Force Basic
          {evalMode === "force_basic" && <span className="ml-auto text-[10px]">✓</span>}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
