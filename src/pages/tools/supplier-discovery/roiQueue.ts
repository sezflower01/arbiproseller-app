/**
 * Global ROI request queue with concurrency control + 429 backoff.
 *
 * Why: when Store Scan results render dozens of rows, each row's
 * `useLiveRoi` would fire `calculate-roi` in parallel, blowing past
 * Amazon SP-API's per-second quota and causing 429 QUOTA_EXCEEDED for
 * almost every row → all rows show "n/a".
 *
 * This queue:
 *  - limits concurrency to MAX_CONCURRENT (default 3)
 *  - retries on 429 / QUOTA_EXCEEDED with exponential backoff
 *  - is shared across ALL hook instances on the page
 */
import { supabase } from "@/integrations/supabase/client";

// Conservative defaults — Amazon SP-API throttles aggressively when many
// rows refresh at once. With 50 visible rows, concurrency=3 caused most
// rows to hit QUOTA_EXCEEDED and render "n/a".
const MAX_CONCURRENT = 2;
const MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 2000;
// Minimum spacing between task starts (gentle pacing on top of concurrency).
const MIN_TASK_SPACING_MS = 350;
let lastDispatchAt = 0;

interface QueueTask {
  asin: string;
  cost: number;
  marketplace: string;
  resolve: (data: any) => void;
  reject: (err: unknown) => void;
}

const queue: QueueTask[] = [];
let active = 0;

function isQuotaError(err: any): boolean {
  const msg = String(err?.message ?? err ?? "");
  const ctxMsg = String(err?.context?.body ?? "");
  return /429|quota|rate limit/i.test(msg) || /429|quota|rate limit/i.test(ctxMsg);
}

async function runTask(task: QueueTask) {
  let attempt = 0;
  // Pace task starts to avoid lockstep bursts against SP-API.
  const now = Date.now();
  const sinceLast = now - lastDispatchAt;
  const wait = Math.max(0, MIN_TASK_SPACING_MS - sinceLast) + Math.random() * 200;
  lastDispatchAt = now + wait;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));

  while (true) {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");

      const { data, error } = await supabase.functions.invoke("calculate-roi", {
        body: { asin: task.asin, cost: task.cost, marketplace: task.marketplace },
        headers: { Authorization: `Bearer ${session.access_token}` },
      });

      if (error) throw error;
      task.resolve(data);
      return;
    } catch (err) {
      attempt++;
      if (isQuotaError(err) && attempt <= MAX_RETRIES) {
        const delay = BASE_BACKOFF_MS * Math.pow(2, attempt - 1) + Math.random() * 500;
        console.warn(`[roiQueue] 429 for ${task.asin}, retry ${attempt}/${MAX_RETRIES} in ${Math.round(delay)}ms`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      task.reject(err);
      return;
    }
  }
}

function pump() {
  while (active < MAX_CONCURRENT && queue.length > 0) {
    const task = queue.shift()!;
    active++;
    runTask(task).finally(() => {
      active--;
      pump();
    });
  }
}

export function enqueueRoi(asin: string, cost: number, marketplace: string): Promise<any> {
  return new Promise((resolve, reject) => {
    queue.push({ asin, cost, marketplace, resolve, reject });
    pump();
  });
}
