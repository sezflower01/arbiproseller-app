import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { format } from "date-fns";
import { translateRepricerReason, translateGuardBadge, buildNarrative } from "@/lib/repricerReasonTranslator";
import { getMarketplaceConfig } from "@/lib/marketplaceCurrency";

interface PriceAction {
  id: string;
  created_at: string;
  asin: string;
  sku: string | null;
  marketplace: string | null;
  old_price: number | null;
  new_price: number | null;
  old_min_price: number | null;
  new_min_price: number | null;
  old_max_price: number | null;
  new_max_price: number | null;
  action_type: string;
  trigger_source: string;
  reason: string | null;
  intelligence_factors: any;
  success: boolean | null;
  error_message: string | null;
  rule_name: string | null;
  update_method: string | null;
  intended_price: number | null;
  submitted_price: number | null;
  amazon_accepted_price: number | null;
  effective_floor_cents: number | null;
  overlay_tag: string | null;
  reconciliation_status: string | null;
  reconciliation_reason?: string | null;
  verified_live_price?: number | null;
  verified_at?: string | null;
}

interface Props {
  action: PriceAction | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function PriceActionDetailDialog({ action, open, onOpenChange }: Props) {
  if (!action) return null;

  const mpConfig = getMarketplaceConfig(action.marketplace || "US");
  const cs = mpConfig.currencySymbol;
  const f = (v: any) => fmt(v, cs);

  const intel = action.intelligence_factors || {};
  const trace = intel?.price_trace || {};
  const posProof = intel?.position_proof || {};
  const profitGuard = intel?.profit_guard || {};
  const bounds = intel?.bounds || {};
  const reasonCodes = intel?.reason_codes || {};
  const timing = intel?.timing || {};
  const guards = intel?.guards_applied || [];
  const summary = intel?.intelligence_summary || {};

  const delta = action.new_price != null && action.old_price != null ? action.new_price - action.old_price : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="font-mono">{action.asin}</span>
            <Badge variant={action.action_type === "price_change" ? "default" : "secondary"}>
              {action.action_type}
            </Badge>
            {action.success === false && <Badge variant="destructive">Error</Badge>}
          </DialogTitle>
        </DialogHeader>

        <ScrollArea className="max-h-[70vh] pr-4">
          <div className="space-y-4 text-sm">
            {/* Summary */}
            <Section title="Summary">
              <Row label="Date" value={format(new Date(action.created_at), "PPpp")} />
              <Row label="SKU" value={action.sku} />
              <Row label="Marketplace" value={action.marketplace} />
              <Row label="Rule" value={action.rule_name} />
              <Row label="Trigger" value={action.trigger_source} />
              <Row label="Method" value={action.update_method} />
              {action.overlay_tag && <Row label="Overlay" value={action.overlay_tag} />}
            </Section>

            {/* Pricing */}
            <Section title="Pricing">
              <Row label="My Price (before)" value={f(action.old_price)} />
              <Row label="New Price" value={f(action.new_price)} highlight={!!delta} />
              {delta != null && (
                <Row label="Change" value={`${delta > 0 ? "+" : ""}${cs}${delta.toFixed(2)} (${action.old_price ? ((delta / action.old_price) * 100).toFixed(1) : 0}%)`} />
              )}
              <Row label="Intended Price" value={f(action.intended_price)} />
              <Row label="Submitted Price" value={f(action.submitted_price)} />
              <Row label="Amazon Accepted" value={f(action.amazon_accepted_price)} />
              <Row label="Min Floor" value={action.effective_floor_cents != null ? `${cs}${(action.effective_floor_cents / 100).toFixed(2)}` : null} />
              <Row label="Min Price" value={f(action.old_min_price)} />
              <Row label="Max Price" value={f(action.old_max_price)} />
            </Section>

            {/* Market Snapshot */}
            <Section title="Market Snapshot">
              <Row label="Buy Box Price" value={f(trace.buybox_price)} />
              <Row label="BB Source" value={trace.bb_source} />
              <Row label="BB Confidence" value={trace.bb_confidence || reasonCodes.bb_confidence} />
              <Row label="Lowest FBA" value={f(trace.lowest_fba)} />
              <Row label="Lowest Overall" value={f(trace.lowest_overall)} />
              <Row label="Anchor Source" value={trace.anchor_source || reasonCodes.anchor_source} />
              <Row label="Mode" value={trace.mode} />
              <Row label="Clamped By" value={trace.clamped_by} />
            </Section>

            {/* Position Proof */}
            {Object.keys(posProof).length > 0 && (
              <Section title="Position Proof">
                <Row label="Am I Lowest (filtered)" value={posProof.am_i_lowest_filtered?.toString()} />
                <Row label="BB Owner is Me" value={posProof.buy_box_owner_is_me?.toString()} />
                <Row label="My Price (landed)" value={f(posProof.my_price)} />
                {posProof.has_shipping && posProof.my_item_price != null && (
                  <div className="ml-3 text-xs text-muted-foreground flex gap-2">
                    <span>Item: {f(posProof.my_item_price)}</span>
                    <span>+ Ship: {f(posProof.my_shipping ?? 0)}</span>
                  </div>
                )}
                <Row label="Lowest Price (filtered)" value={f(posProof.lowest_price_filtered)} />
                {posProof.has_shipping && posProof.lowest_item_price != null && (
                  <div className="ml-3 text-xs text-muted-foreground flex gap-2">
                    <span>Item: {f(posProof.lowest_item_price)}</span>
                    <span>+ Ship: {f(posProof.lowest_shipping ?? 0)}</span>
                  </div>
                )}
                <Row label="Next Competitor (landed)" value={f(posProof.next_competitor_price)} />
                {posProof.has_shipping && posProof.next_competitor_item_price != null && (
                  <div className="ml-3 text-xs text-muted-foreground flex gap-2">
                    <span>Item: {f(posProof.next_competitor_item_price)}</span>
                    <span>+ Ship: {f(posProof.next_competitor_shipping ?? 0)}</span>
                  </div>
                )}
                <Row label="Competitor Count" value={posProof.competitor_count_filtered?.toString()} />
                {posProof.is_price_cluster && <Row label="Price Cluster" value="Yes" />}
                {posProof.has_shipping && (
                  <p className="text-xs text-blue-600 dark:text-blue-400 mt-1">📦 All comparisons use landed price (item + shipping)</p>
                )}
              </Section>
            )}

            {/* Profit Guard */}
            {Object.keys(profitGuard).length > 0 && (
              <Section title="Profit Guard">
                <Row label="Blocked" value={profitGuard.blocked?.toString()} />
                <Row label="Unit Cost" value={f(profitGuard.unit_cost)} />
                <Row label="Cost Source" value={profitGuard.cost_source} />
                <Row label="Estimated Fees" value={f(profitGuard.estimated_fees)} />
                <Row label="Fees Source" value={profitGuard.fees_source} />
                <Row label="Min ROI" value={profitGuard.effective_min_roi != null ? `${profitGuard.effective_min_roi}%` : null} />
                <Row label="Profit Floor" value={f(profitGuard.profit_floor_price)} />
                <Row label="Mode" value={profitGuard.mode} />
              </Section>
            )}

            {/* Guards */}
            {guards.length > 0 && (
              <Section title="Guards Applied">
                <div className="flex flex-wrap gap-1">
                  {guards.map((g: string) => (
                    <Badge key={g} variant="outline" className="text-xs">{translateGuardBadge(g)}</Badge>
                  ))}
                </div>
              </Section>
            )}

            {/* Intelligence Summary */}
            {Object.keys(summary).length > 0 && (
              <Section title="Intelligence Summary">
                <Row label="FBA Competitors" value={summary.fba_competitors?.toString()} />
                <Row label="BB Win Rate" value={summary.bb_win_rate != null ? `${(summary.bb_win_rate * 100).toFixed(0)}%` : null} />
                <Row label="BB Loss Streak" value={summary.bb_loss_streak?.toString()} />
                <Row label="Days of Stock" value={summary.days_of_stock?.toString()} />
                <Row label="Stock Modifier" value={summary.stock_modifier?.toString()} />
                <Row label="Urgency" value={summary.urgency?.toString()} />
                <Row label="Velocity" value={summary.velocity?.toString()} />
              </Section>
            )}

            {/* Timing */}
            {Object.keys(timing).length > 0 && (
              <Section title="Timing (ms)">
                <Row label="Total" value={`${timing.total_ms}ms`} />
                <Row label="Intel" value={`${timing.intel_ms}ms`} />
                <Row label="Context" value={`${timing.context_ms}ms`} />
                <Row label="Write" value={`${timing.write_ms}ms`} />
              </Section>
            )}

            {/* Reason — Human-Readable Narrative */}
            <Section title="What Happened">
              <div className="text-sm whitespace-pre-wrap bg-primary/5 p-4 rounded-md border border-primary/10 leading-relaxed">
                {buildNarrative({
                  action_type: action.action_type,
                  reason: action.reason,
                  old_price: action.old_price,
                  new_price: action.new_price,
                  intended_price: action.intended_price,
                  success: action.success,
                  error_message: action.error_message,
                  intelligence_factors: action.intelligence_factors,
                  rule_name: action.rule_name,
                  overlay_tag: action.overlay_tag,
                  old_min_price: action.old_min_price,
                  old_max_price: action.old_max_price,
                  effective_floor_cents: action.effective_floor_cents,
                })}
              </div>
            </Section>

            {/* Reason — Raw (for debugging) */}
            <Section title="Raw Technical Reason">
              <p className="text-xs font-mono whitespace-pre-wrap bg-muted/50 p-3 rounded-md text-muted-foreground">
                {action.reason || "No reason provided"}
              </p>
            </Section>

            {/* Error */}
            {action.error_message && (
              <Section title="Error">
                <p className="text-xs font-mono text-destructive bg-destructive/10 p-3 rounded-md">
                  {action.error_message}
                </p>
              </Section>
            )}

            {/* Verification Pipeline */}
            {(action.reconciliation_status || action.verified_at || action.verified_live_price != null) && (() => {
              const status = action.reconciliation_status;
              const stages = [
                { key: 'target', label: 'Target calculated', done: action.intended_price != null },
                { key: 'submit', label: 'Submitted to Amazon', done: action.success === true && action.submitted_price != null },
                { key: 'ack', label: 'Amazon acknowledged (PATCH 200)', done: action.success === true },
                { key: 'verified', label: 'Live price verified on Amazon', done: status === 'matched' },
              ];
              const banner =
                status === 'matched' ? { icon: '✅', text: 'Live price verified on Amazon', cls: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-300' } :
                status === 'mismatch' ? { icon: '⚠️', text: 'Price update not yet verified on Amazon (mismatch)', cls: 'bg-amber-500/10 border-amber-500/30 text-amber-700 dark:text-amber-300' } :
                status === 'pending_timeout' ? { icon: '⚠️', text: 'Verification timeout — Amazon never reflected the submitted price', cls: 'bg-amber-500/10 border-amber-500/30 text-amber-700 dark:text-amber-300' } :
                status === 'failed' ? { icon: '⚠️', text: 'Verification failed', cls: 'bg-destructive/10 border-destructive/30 text-destructive' } :
                status === 'recheck' ? { icon: '🟡', text: 'Submitted — re-checking Amazon live offer', cls: 'bg-yellow-500/10 border-yellow-500/30 text-yellow-700 dark:text-yellow-300' } :
                status === 'non_reconcilable' ? { icon: 'ℹ️', text: 'Reconciliation skipped (non-reconcilable variant)', cls: 'bg-muted border-border text-muted-foreground' } :
                { icon: '🟡', text: 'Submitted to Amazon — verifying live offer', cls: 'bg-yellow-500/10 border-yellow-500/30 text-yellow-700 dark:text-yellow-300' };
              return (
                <Section title="Verification Pipeline">
                  <div className={`text-xs p-2 rounded-md border ${banner.cls} mb-2`}>
                    {banner.icon} {banner.text}
                  </div>
                  <ol className="text-xs space-y-1 ml-1">
                    {stages.map(s => (
                      <li key={s.key}>
                        <span className={s.done ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}>
                          {s.done ? '✓' : '○'} {s.label}
                        </span>
                      </li>
                    ))}
                  </ol>
                  <div className="mt-2">
                    <Row label="Status" value={status} />
                    <Row label="Intended Price" value={f(action.intended_price)} />
                    <Row label="Submitted Price" value={f(action.submitted_price)} />
                    <Row label="Live Price (verified)" value={f(action.verified_live_price)} />
                    <Row label="Verified At" value={action.verified_at ? format(new Date(action.verified_at), "PPpp") : null} />
                    <Row label="Reconciliation Note" value={action.reconciliation_reason} />
                  </div>
                </Section>
              );
            })()}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-2">{title}</h4>
      <div className="space-y-1">{children}</div>
      <Separator className="mt-3" />
    </div>
  );
}

function Row({ label, value, highlight }: { label: string; value: any; highlight?: boolean }) {
  if (value == null || value === "" || value === "undefined") return null;
  return (
    <div className="flex justify-between items-center">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("font-mono", highlight && "font-semibold")}>{value}</span>
    </div>
  );
}

function fmt(v: any, symbol: string = "$"): string | null {
  if (v == null) return null;
  const n = Number(v);
  if (isNaN(n)) return String(v);
  return `${symbol}${n.toFixed(2)}`;
}

function cn(...classes: (string | boolean | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}
