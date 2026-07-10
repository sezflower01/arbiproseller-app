import { useState } from "react";
import { Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { invokeEdgeFunction } from "@/lib/edgeFunctionClient";
import { toast } from "sonner";

type PushBoundsToAmazonButtonProps = {
  className?: string;
  label?: string;
  marketplace?: string | null;
  size?: "default" | "sm" | "lg" | "icon";
  variant?: "default" | "destructive" | "outline" | "secondary" | "ghost" | "link";
};

type PushBoundsResponse = {
  success?: boolean;
  pushed?: number;
  errors?: number;
  remaining?: number;
  message?: string;
  error?: string;
};

export default function PushBoundsToAmazonButton({
  className,
  label = "Push Bounds to Amazon",
  marketplace = null,
  size = "sm",
  variant = "outline",
}: PushBoundsToAmazonButtonProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleClick = async () => {
    if (isSubmitting) return;

    setIsSubmitting(true);
    toast.info("Pushing missing min/max bounds to Amazon...");

    try {
      const result = await invokeEdgeFunction<PushBoundsResponse>({
        functionName: "push-bounds-to-amazon",
        body: {
          limit: 200,
          ...(marketplace ? { marketplace } : {}),
        },
        maxRetries: 1,
        context: {
          marketplace: marketplace ?? "ALL",
        },
      });

      if (!result.ok || !result.data?.success) {
        toast.error(result.errorMessage || result.data?.error || "Push Bounds failed");
        return;
      }

      if (result.data.message) {
        toast.success(result.data.message);
        return;
      }

      const pushed = result.data.pushed ?? 0;
      const errors = result.data.errors ?? 0;
      const remaining = result.data.remaining ?? 0;
      const assignmentLabel = pushed === 1 ? "assignment" : "assignments";

      toast.success(
        `Pushed ${pushed} ${assignmentLabel}${errors > 0 ? `, ${errors} errors` : ""}${remaining > 0 ? `, ${remaining} remaining` : ""}`
      );
    } catch (error: any) {
      toast.error(error?.message || "Push Bounds failed");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      className={className}
      disabled={isSubmitting}
      onClick={handleClick}
    >
      {isSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
      {label}
    </Button>
  );
}
