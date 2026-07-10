import { useState, useRef, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import { Wrench, CheckCircle, AlertCircle, Loader2, SkipForward, Clock } from "lucide-react";
import { cn } from "@/lib/utils";

interface FixDataQualityButtonProps {
  userId: string;
  dateFilter: string;
  targetDate?: string;
  session: { access_token: string } | null;
  onComplete: () => void;
  className?: string;
}

interface StepResult {
  step: string;
  status: "pending" | "running" | "success" | "error" | "skipped" | "timeout";
  message?: string;
}

type Step = { id: string; label: string; estimate?: string };

const STEPS: Step[] = [
  { id: "refresh", label: "Refresh Pending Orders", estimate: "~30s" },
  { id: "enrich", label: "Enrich Pending Orders", estimate: "~30s" },
  { id: "snapshots", label: "Backfill Snapshots", estimate: "~30s" },
  { id: "fees", label: "Backfill Fee Cache", estimate: "~30s" },
  { id: "prices", label: "Repair Estimated Prices", estimate: "~30s" },
  { id: "resolve", label: "Resolve Prices via SP-API", estimate: "~60s" },
];

const BATCH_TIMEOUT_MS = 45_000;
const SKIP_SHOW_THRESHOLD_SECONDS = 20;
const REFRESH_BATCH_SIZE = 15;
const ENRICH_BATCH_SIZE = 10;
const MAX_BATCHES = 6;

type InvokeResult<T> = { data: T | null; error: any | null; timedOut: boolean };

async function invokeWithTimeout<T = any>(
  name: string,
  options: Parameters<typeof supabase.functions.invoke>[1],
  timeoutMs: number
): Promise<InvokeResult<T>> {
  const invokePromise = (supabase.functions.invoke(name, options) as Promise<any>)
    .then((r) => ({ data: r.data ?? null, error: r.error ?? null, timedOut: false }))
    .catch((e) => ({ data: null, error: e, timedOut: false }));

  const timeoutPromise = new Promise<InvokeResult<T>>((resolve) => {
    setTimeout(() => resolve({ data: null, error: new Error(`${name} timed out after ${Math.round(timeoutMs / 1000)}s`), timedOut: true }), timeoutMs);
  });

  return Promise.race([invokePromise, timeoutPromise]);
}

export function FixDataQualityButton({
  userId,
  dateFilter,
  targetDate,
  session,
  onComplete,
  className,
}: FixDataQualityButtonProps) {
  const [isRunning, setIsRunning] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const [stepResults, setStepResults] = useState<StepResult[]>([]);
  const [elapsedSeconds, setElapsedSeconds] = useState<Record<string, number>>({});

  const stepStartedAtRef = useRef<number | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const skipResolverRef = useRef<(() => void) | null>(null);

  const updateStepStatus = useCallback((stepId: string, status: StepResult["status"], message?: string) => {
    setStepResults((prev) => {
      const existing = prev.find((s) => s.step === stepId);
      if (existing) {
        return prev.map((s) => (s.step === stepId ? { ...s, status, message } : s));
      }
      return [...prev, { step: stepId, status, message }];
    });
  }, []);

  useEffect(() => {
    if (!isRunning || currentStep < 1) {
      if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
      return;
    }
    const stepId = STEPS[currentStep - 1]?.id;
    if (!stepId) return;
    stepStartedAtRef.current = Date.now();
    setElapsedSeconds((prev) => ({ ...prev, [stepId]: 0 }));
    tickRef.current = setInterval(() => {
      if (!stepStartedAtRef.current) return;
      setElapsedSeconds((prev) => ({ ...prev, [stepId]: Math.floor((Date.now() - stepStartedAtRef.current!) / 1000) }));
    }, 1000);
    return () => { if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; } };
  }, [isRunning, currentStep]);

  const handleSkipStep = useCallback(() => { skipResolverRef.current?.(); }, []);

  /** Run a chunked/looping step (for refresh & enrich) */
  const runChunkedStep = async (
    stepIndex: number,
    stepId: string,
    invokeFn: () => Promise<{ count: number; has_more: boolean; message: string }>
  ): Promise<{ totalCount: number; status: "success" | "timeout" | "error" | "skipped"; message: string }> => {
    setCurrentStep(stepIndex);
    updateStepStatus(stepId, "running");

    let totalCount = 0;
    let batchNum = 0;
    let lastMessage = "";
    let wasSkipped = false;

    while (batchNum < MAX_BATCHES) {
      batchNum++;

      const runPromise = invokeFn()
        .then((r) => ({ type: "success" as const, result: r }))
        .catch((e) => ({ type: "error" as const, error: e }));

      const skipPromise = new Promise<{ type: "skipped" }>((resolve) => {
        skipResolverRef.current = () => resolve({ type: "skipped" });
      });

      const outcome = await Promise.race([runPromise, skipPromise]);
      skipResolverRef.current = null;

      if (outcome.type === "skipped") {
        wasSkipped = true;
        break;
      }

      if (outcome.type === "error") {
        const isTimeout = outcome.error?.timedOut || String(outcome.error?.message || "").includes("timed out");
        if (isTimeout && totalCount > 0) {
          lastMessage = `${totalCount} updated before timeout`;
          updateStepStatus(stepId, "timeout", lastMessage);
          return { totalCount, status: "timeout", message: lastMessage };
        }
        if (isTimeout) {
          updateStepStatus(stepId, "timeout", "Timed out after 45s");
          return { totalCount: 0, status: "timeout", message: "Timed out after 45s" };
        }
        const msg = outcome.error?.message || "Unknown error";
        updateStepStatus(stepId, "error", msg);
        return { totalCount, status: "error", message: msg };
      }

      totalCount += outcome.result.count;
      lastMessage = `${totalCount} updated (batch ${batchNum})`;
      updateStepStatus(stepId, "running", lastMessage);

      if (!outcome.result.has_more) break;
    }

    if (wasSkipped) {
      const msg = totalCount > 0 ? `Skipped after ${totalCount} updated` : "Skipped by user";
      updateStepStatus(stepId, "skipped", msg);
      return { totalCount, status: "skipped", message: msg };
    }

    const finalMsg = `${totalCount} updated`;
    updateStepStatus(stepId, "success", finalMsg);
    return { totalCount, status: "success", message: finalMsg };
  };

  /** Run a single-shot step (for non-pending steps) */
  const runSingleStep = async (
    stepIndex: number,
    stepId: string,
    fn: () => Promise<{ count: number; message: string }>
  ) => {
    setCurrentStep(stepIndex);
    updateStepStatus(stepId, "running");

    const runPromise = fn()
      .then((r) => ({ type: "success" as const, result: r }))
      .catch((e) => ({ type: "error" as const, error: e }));

    const skipPromise = new Promise<{ type: "skipped" }>((resolve) => {
      skipResolverRef.current = () => resolve({ type: "skipped" });
    });

    const outcome = await Promise.race([runPromise, skipPromise]);
    skipResolverRef.current = null;

    if (outcome.type === "skipped") {
      updateStepStatus(stepId, "skipped", "Skipped by user");
      return 0;
    }

    if (outcome.type === "error") {
      const isTimeout = outcome.error?.timedOut || String(outcome.error?.message || "").includes("timed out");
      if (isTimeout) {
        updateStepStatus(stepId, "timeout", "Timed out");
      } else {
        updateStepStatus(stepId, "error", outcome.error?.message || "Unknown error");
      }
      return 0;
    }

    updateStepStatus(stepId, "success", outcome.result.message);
    return outcome.result.count;
  };

  const handleFixDataQuality = async () => {
    if (!userId) return;
    setIsRunning(true);
    setCurrentStep(0);
    setElapsedSeconds({});
    setStepResults(STEPS.map((s) => ({ step: s.id, status: "pending" as const })));

    const authHeaders = session?.access_token
      ? { Authorization: `Bearer ${session.access_token}` }
      : undefined;

    let totalFixed = 0;

    try {
      // Step 1: Refresh Pending Orders (chunked)
      const refreshResult = await runChunkedStep(1, "refresh", async () => {
        const { data, error, timedOut } = await invokeWithTimeout(
          "sync-sales-orders",
          { body: { refresh_pending: true, target_date: targetDate, limit: REFRESH_BATCH_SIZE } },
          BATCH_TIMEOUT_MS
        );
        if (timedOut) throw { timedOut: true, message: "timed out" };
        if (error) throw error;
        const d = data as any;
        return {
          count: d?.updatedCount || 0,
          has_more: d?.has_more === true,
          message: `${d?.updatedCount || 0} refreshed`,
        };
      });
      totalFixed += refreshResult.totalCount;

      // Step 2: Enrich Pending Orders (chunked)
      const enrichResult = await runChunkedStep(2, "enrich", async () => {
        const { data, error, timedOut } = await invokeWithTimeout(
          "enrich-pending-orders",
          { body: { force: true, limit: ENRICH_BATCH_SIZE, target_date: targetDate }, headers: authHeaders },
          BATCH_TIMEOUT_MS
        );
        if (timedOut) throw { timedOut: true, message: "timed out" };
        if (error) throw error;
        const d = data as any;
        const count = (d?.stuckPendingSuccess || 0) + (d?.successCount || 0);
        return {
          count,
          has_more: d?.has_more === true,
          message: `${count} enriched`,
        };
      });
      totalFixed += enrichResult.totalCount;

      // Step 3: Backfill Snapshots
      totalFixed += await runSingleStep(3, "snapshots", async () => {
        const { data, error, timedOut } = await invokeWithTimeout(
          "backfill-order-snapshots",
          { headers: authHeaders, body: {} },
          BATCH_TIMEOUT_MS
        );
        if (timedOut) throw { timedOut: true, message: "timed out" };
        if (error) throw error;
        const inserted = (data as any)?.inserted || 0;
        return { count: inserted, message: `${inserted} snapshots created` };
      });

      // Step 4: Backfill Fee Cache
      totalFixed += await runSingleStep(4, "fees", async () => {
        const { data, error, timedOut } = await invokeWithTimeout(
          "backfill-fee-cache",
          { body: { user_id: userId, max_asins: 20 } },
          BATCH_TIMEOUT_MS
        );
        if (timedOut) throw { timedOut: true, message: "timed out" };
        if (error) throw error;
        const cached = (data as any)?.cached || 0;
        const ordersUpdated = (data as any)?.ordersUpdated || 0;
        return { count: ordersUpdated, message: `${cached} ASINs cached, ${ordersUpdated} orders updated` };
      });

      // Step 5: Repair Estimated Prices
      totalFixed += await runSingleStep(5, "prices", async () => {
        const { data, error, timedOut } = await invokeWithTimeout(
          "repair-pending-prices",
          { body: { limit: 100 }, headers: authHeaders },
          BATCH_TIMEOUT_MS
        );
        if (timedOut) throw { timedOut: true, message: "timed out" };
        if (error) throw error;
        const repaired = (data as any)?.repaired || 0;
        return { count: repaired, message: `${repaired} prices repaired` };
      });

      // Step 6: Resolve Prices via SP-API
      totalFixed += await runSingleStep(6, "resolve", async () => {
        const { data, error, timedOut } = await invokeWithTimeout(
          "enrich-pending-orders",
          { body: { force: true, limit: 50, resolve_prices: true, target_date: targetDate }, headers: authHeaders },
          BATCH_TIMEOUT_MS
        );
        if (timedOut) throw { timedOut: true, message: "timed out" };
        if (error) throw error;
        const resolved = (data as any)?.pricesResolved || (data as any)?.stuckPendingSuccess || 0;
        return { count: resolved, message: `${resolved} prices resolved` };
      });

      const hasErrors = stepResults.some((r) => r.status === "error");
      const hasTimeouts = stepResults.some((r) => r.status === "timeout");
      if (!hasErrors && !hasTimeouts) {
        toast.success(`Data quality fix complete! ${totalFixed} improvements made.`);
      } else {
        toast.warning(`Partial fix: ${totalFixed} improvements. Some steps timed out or had errors.`);
      }

      onComplete();
    } catch (err: any) {
      console.error("Fix data quality error:", err);
      toast.error("Failed to fix data quality: " + (err.message || "Unknown error"));
    } finally {
      setIsRunning(false);
      setCurrentStep(0);
      if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
      skipResolverRef.current = null;
    }
  };

  const progressPercent = isRunning ? (currentStep / STEPS.length) * 100 : 0;
  const currentStepId = currentStep > 0 ? STEPS[currentStep - 1]?.id : null;
  const currentElapsed = currentStepId ? (elapsedSeconds[currentStepId] ?? 0) : 0;
  const showSkip = isRunning && currentStep > 0 && currentElapsed >= SKIP_SHOW_THRESHOLD_SECONDS;

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <Button
        onClick={handleFixDataQuality}
        disabled={isRunning}
        className="bg-primary hover:bg-primary/90 text-primary-foreground font-semibold"
        size="default"
      >
        {isRunning ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Step {currentStep}/{STEPS.length}
          </>
        ) : (
          <>
            <Wrench className="mr-2 h-4 w-4" />
            Fix Data Quality
          </>
        )}
      </Button>

      {isRunning && (
        <div className="space-y-2">
          <Progress value={progressPercent} className="h-2" />

          {showSkip && (
            <Button variant="outline" size="sm" onClick={handleSkipStep} className="w-full text-xs gap-1">
              <SkipForward className="h-3 w-3" />
              Skip this step and continue
            </Button>
          )}

          <div className="flex flex-col gap-1 text-xs">
            {STEPS.map((step) => {
              const result = stepResults.find((r) => r.step === step.id);
              const status = result?.status || "pending";
              const elapsed = elapsedSeconds[step.id];

              return (
                <div
                  key={step.id}
                  className={cn(
                    "flex items-center gap-2 py-0.5 px-2 rounded",
                    status === "running" && "bg-accent",
                    status === "success" && "bg-accent",
                    status === "error" && "bg-destructive/10",
                    status === "timeout" && "bg-destructive/10",
                    status === "skipped" && "bg-muted"
                  )}
                >
                  {status === "pending" && <div className="h-3 w-3 rounded-full border border-muted-foreground" />}
                  {status === "running" && <Loader2 className="h-3 w-3 animate-spin text-primary" />}
                  {status === "success" && <CheckCircle className="h-3 w-3 text-primary" />}
                  {status === "error" && <AlertCircle className="h-3 w-3 text-destructive" />}
                  {status === "timeout" && <Clock className="h-3 w-3 text-destructive" />}
                  {status === "skipped" && <SkipForward className="h-3 w-3 text-muted-foreground" />}

                  <span
                    className={cn(
                      "text-muted-foreground flex-1",
                      status === "running" && "text-foreground font-medium",
                      status === "success" && "text-foreground",
                      status === "error" && "text-destructive",
                      status === "timeout" && "text-destructive",
                      status === "skipped" && "text-muted-foreground line-through"
                    )}
                  >
                    {step.label}
                  </span>

                  {status === "running" && elapsed !== undefined && (
                    <span className="text-[10px] text-muted-foreground tabular-nums">{elapsed}s</span>
                  )}

                  {result?.message && status !== "running" && (
                    <span className="text-[10px] opacity-75 max-w-[140px] truncate">{result.message}</span>
                  )}
                  {result?.message && status === "running" && (
                    <span className="text-[10px] text-muted-foreground max-w-[140px] truncate">{result.message}</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default FixDataQualityButton;
