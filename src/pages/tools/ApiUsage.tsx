import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, RefreshCw, ExternalLink, AlertTriangle } from "lucide-react";
import { Helmet } from "react-helmet-async";
import Navbar from "@/components/Navbar";
import { useApiUsage, type SearchDay } from "@/hooks/use-api-usage";

/**
 * Google CSE free allowance. The only hard, documented daily limit among these
 * providers, and the one most likely to start costing money quietly:
 * USD 5 per 1000 queries beyond it.
 */
const CSE_FREE_PER_DAY = 100;
const CSE_COST_PER_1000 = 5;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function sumFor(days: SearchDay[], provider: SearchDay["provider"], date: string) {
  return days.filter((d) => d.provider === provider && d.usage_date === date)
    .reduce((s, d) => s + d.call_count, 0);
}

function Stat({ label, value, sub, tone }: {
  label: string; value: string; sub?: string; tone?: "ok" | "warn" | "bad";
}) {
  const colour = tone === "bad" ? "text-destructive"
    : tone === "warn" ? "text-amber-600"
    : "";
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-2xl font-semibold tabular-nums ${colour}`}>{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}

/** Provider name + a direct link, so the authoritative source is one click away. */
function ProviderHeader({ name, href, note }: { name: string; href: string; note?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 mb-3">
      <h2 className="text-sm font-semibold">{name}</h2>
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="text-xs text-primary hover:underline inline-flex items-center gap-1 shrink-0"
      >
        {note || "Provider dashboard"} <ExternalLink className="h-3 w-3" />
      </a>
    </div>
  );
}

export default function ApiUsage() {
  const { data, loading, error, refresh } = useApiUsage();
  const today = todayIso();

  const cseToday = data ? sumFor(data.searchDays, "google_cse", today) : 0;
  const serpToday = data ? sumFor(data.searchDays, "serpapi", today) : 0;
  const cseOverage = Math.max(0, cseToday - CSE_FREE_PER_DAY);
  const cseCost = (cseOverage / 1000) * CSE_COST_PER_1000;

  const gemToday = data?.geminiDays.find((d) => d.usage_date === today);
  const keepa = data?.keepaBudget;
  // Percent of the bucket, which is what "running low" actually means here --
  // the plan refills continuously, so an absolute number means little alone.
  const keepaPct = keepa && keepa.bucket_max > 0
    ? Math.round((keepa.tokens_left / keepa.bucket_max) * 100)
    : null;

  return (
    <div className="min-h-screen bg-background">
      <Helmet>
        <title>API Usage | InventorySprint</title>
        <meta name="description" content="Keepa, Gemini and search API usage in one place." />
      </Helmet>
      <Navbar />

      <div className="max-w-[1100px] mx-auto px-4 py-6 space-y-4">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h1 className="text-xl font-semibold">API usage</h1>
            <p className="text-xs text-muted-foreground mt-1">
              Measured by this app, not read from the providers. Keepa is the exception — it
              reports its own balance on every call, so that figure is real.
            </p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={refresh} disabled={loading}>
            {loading ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1" />}
            Refresh
          </Button>
        </div>

        {error && (
          <Card><CardContent className="p-4 text-sm text-destructive">
            Could not load usage: {error}
          </CardContent></Card>
        )}

        {loading && !data ? (
          <Card><CardContent className="p-10 text-center text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mx-auto" />
          </CardContent></Card>
        ) : data && (
          <>
            {/* ── Keepa ─────────────────────────────────────────────── */}
            <Card>
              <CardContent className="p-4">
                <ProviderHeader name="Keepa" href="https://keepa.com/#!api" note="keepa.com/#!api" />
                {keepa ? (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                    <Stat
                      label="Tokens available"
                      value={`${Math.floor(keepa.tokens_left).toLocaleString()}`}
                      sub={`of ${keepa.bucket_max.toLocaleString()} · ${keepaPct}%`}
                      tone={keepaPct !== null && keepaPct < 25 ? "bad" : keepaPct !== null && keepaPct < 50 ? "warn" : "ok"}
                    />
                    <Stat label="Refill" value={`${keepa.refill_per_min}/min`} sub={`${keepa.refill_per_min * 60}/hour`} />
                    <Stat
                      label="Gate denials"
                      value={keepa.denied_count.toLocaleString()}
                      sub={keepa.last_denied_at ? `last ${new Date(keepa.last_denied_at).toLocaleTimeString()}` : "none"}
                      tone={keepa.denied_count > 0 ? "warn" : "ok"}
                    />
                    <Stat
                      label="429s today"
                      value={(data.keepaDays.find((d) => d.usage_date === today)?.keepa_429_count ?? 0).toLocaleString()}
                      sub="hard refusals from Keepa"
                    />
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No budget row yet.</p>
                )}
                {/* Denials are OUR gate holding back low-priority callers, not
                    Keepa refusing us. Conflating the two would read as an
                    outage when it is the reserve working as designed. */}
                <p className="text-xs text-muted-foreground mt-3 border-t pt-3">
                  Denials are this app's own rate gate protecting the repricer's reserve — not
                  refusals from Keepa. A 429 is Keepa refusing.
                </p>
              </CardContent>
            </Card>

            {/* ── Google CSE ────────────────────────────────────────── */}
            <Card>
              <CardContent className="p-4">
                <ProviderHeader
                  name="Google Custom Search"
                  href="https://console.cloud.google.com/apis/api/customsearch.googleapis.com/metrics"
                  note="Cloud console metrics"
                />
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <Stat
                    label="Queries today"
                    value={cseToday.toLocaleString()}
                    sub={`${CSE_FREE_PER_DAY} free per day`}
                    tone={cseToday > CSE_FREE_PER_DAY ? "bad" : cseToday > CSE_FREE_PER_DAY * 0.8 ? "warn" : "ok"}
                  />
                  <Stat
                    label="Billable today"
                    value={cseOverage.toLocaleString()}
                    sub={cseOverage > 0 ? `≈ $${cseCost.toFixed(2)}` : "within free tier"}
                    tone={cseOverage > 0 ? "warn" : "ok"}
                  />
                  <Stat
                    label="Empty results"
                    value={(data.searchDays.find((d) => d.provider === "google_cse" && d.usage_date === today)?.empty_count ?? 0).toLocaleString()}
                    sub="spent, found nothing"
                  />
                  <Stat
                    label="Errors today"
                    value={(data.searchDays.find((d) => d.provider === "google_cse" && d.usage_date === today)?.error_count ?? 0).toLocaleString()}
                    tone={(data.searchDays.find((d) => d.provider === "google_cse" && d.usage_date === today)?.error_count ?? 0) > 0 ? "bad" : "ok"}
                  />
                </div>
                <p className="text-xs text-muted-foreground mt-3 border-t pt-3">
                  Counted per query, not per search — one source search issues up to four queries
                  (UPC and title, doubled if the retailer allowlist finds nothing).
                </p>
              </CardContent>
            </Card>

            {/* ── SerpAPI ───────────────────────────────────────────── */}
            <Card>
              <CardContent className="p-4">
                <ProviderHeader name="SerpAPI" href="https://serpapi.com/dashboard" note="serpapi.com/dashboard" />
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <Stat
                    label="Queries today"
                    value={serpToday.toLocaleString()}
                    sub="fallback only"
                    tone={serpToday > 0 ? "warn" : "ok"}
                  />
                  <Stat
                    label="Errors today"
                    value={(data.searchDays.find((d) => d.provider === "serpapi" && d.usage_date === today)?.error_count ?? 0).toLocaleString()}
                  />
                </div>
                <p className="text-xs text-muted-foreground mt-3 border-t pt-3">
                  Only runs when Google returns zero results. Any number above zero is worth a
                  look — it usually means CSE is failing or exhausted, not that the fallback is
                  doing useful extra work.
                </p>
              </CardContent>
            </Card>

            {/* ── Gemini ────────────────────────────────────────────── */}
            <Card>
              <CardContent className="p-4">
                <ProviderHeader name="Gemini" href="https://aistudio.google.com/apikey" note="AI Studio" />
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <Stat label="Calls today" value={(gemToday?.call_count ?? 0).toLocaleString()} />
                  <Stat label="Succeeded" value={(gemToday?.success_count ?? 0).toLocaleString()} />
                  <Stat
                    label="Quota failures"
                    value={(gemToday?.quota_failure_count ?? 0).toLocaleString()}
                    sub="429s"
                    tone={(gemToday?.quota_failure_count ?? 0) > 0 ? "bad" : "ok"}
                  />
                  <Stat
                    label="Other failures"
                    value={(gemToday?.other_failure_count ?? 0).toLocaleString()}
                    tone={(gemToday?.other_failure_count ?? 0) > 0 ? "warn" : "ok"}
                  />
                </div>
                {gemToday?.last_failure_at && (
                  <p className="text-xs text-amber-600 mt-3 inline-flex items-center gap-1">
                    <AlertTriangle className="h-3 w-3 shrink-0" />
                    Last failure {new Date(gemToday.last_failure_at).toLocaleTimeString()}
                    {gemToday.last_failure_status ? ` · HTTP ${gemToday.last_failure_status}` : ""}
                    {gemToday.last_failure_caller ? ` · ${gemToday.last_failure_caller}` : ""}
                  </p>
                )}
                <p className="text-xs text-muted-foreground mt-3 border-t pt-3">
                  Gemini exposes no balance to a server-side caller, so there is no "remaining"
                  figure to show — quota failures are the signal that you are at the limit.
                </p>
              </CardContent>
            </Card>

            {/* ── Source searches ───────────────────────────────────── */}
            <Card>
              <CardContent className="p-4">
                <h2 className="text-sm font-semibold mb-3">Source searches</h2>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                  <Stat
                    label="Auto-search today"
                    value={`${data.autoSourceToday.toLocaleString()} / ${data.autoSourceCap.toLocaleString()}`}
                    sub="daily cap"
                    tone={data.autoSourceToday >= data.autoSourceCap ? "warn" : "ok"}
                  />
                  <Stat label="This month" value={data.searchesThisMonth.toLocaleString()} sub="all source searches" />
                </div>
              </CardContent>
            </Card>

            {/* ── Not tracked here ──────────────────────────────────── */}
            <Card>
              <CardContent className="p-4">
                <h2 className="text-sm font-semibold mb-2">Not tracked here</h2>
                <p className="text-xs text-muted-foreground mb-3">
                  These are used by the system but have no counters in this app. Listed so the page
                  is not mistaken for a complete bill.
                </p>
                <div className="flex flex-wrap gap-2">
                  {[
                    { n: "Firecrawl", u: "https://www.firecrawl.dev/app" },
                    { n: "Amazon SP-API", u: "https://sellercentral.amazon.com" },
                    { n: "Best Buy API", u: "https://developer.bestbuy.com" },
                    { n: "Resend", u: "https://resend.com/emails" },
                  ].map((p) => (
                    <a
                      key={p.n}
                      href={p.u}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs hover:bg-muted"
                    >
                      {p.n} <ExternalLink className="h-3 w-3" />
                    </a>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* ── 14-day history ───────────────────────────────────── */}
            <Card>
              <CardContent className="p-4">
                <h2 className="text-sm font-semibold mb-3">Recent days</h2>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="text-muted-foreground">
                      <tr className="text-left border-b">
                        <th className="py-2 pr-4 font-medium">Date</th>
                        <th className="py-2 pr-4 font-medium">CSE</th>
                        <th className="py-2 pr-4 font-medium">SerpAPI</th>
                        <th className="py-2 pr-4 font-medium">Gemini</th>
                        <th className="py-2 pr-4 font-medium">Gemini 429s</th>
                        <th className="py-2 font-medium">Keepa 429s</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Array.from(new Set([
                        ...data.searchDays.map((d) => d.usage_date),
                        ...data.geminiDays.map((d) => d.usage_date),
                        ...data.keepaDays.map((d) => d.usage_date),
                      ])).sort().reverse().slice(0, 14).map((date) => {
                        const g = data.geminiDays.find((d) => d.usage_date === date);
                        const k = data.keepaDays.find((d) => d.usage_date === date);
                        const cse = sumFor(data.searchDays, "google_cse", date);
                        return (
                          <tr key={date} className="border-b last:border-b-0">
                            <td className="py-2 pr-4 tabular-nums">{date}</td>
                            <td className={`py-2 pr-4 tabular-nums ${cse > CSE_FREE_PER_DAY ? "text-amber-600" : ""}`}>{cse}</td>
                            <td className="py-2 pr-4 tabular-nums">{sumFor(data.searchDays, "serpapi", date)}</td>
                            <td className="py-2 pr-4 tabular-nums">{g?.call_count ?? 0}</td>
                            <td className={`py-2 pr-4 tabular-nums ${(g?.quota_failure_count ?? 0) > 0 ? "text-destructive" : ""}`}>
                              {g?.quota_failure_count ?? 0}
                            </td>
                            <td className={`py-2 tabular-nums ${(k?.keepa_429_count ?? 0) > 0 ? "text-destructive" : ""}`}>
                              {k?.keepa_429_count ?? 0}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {data.searchDays.length === 0 && data.geminiDays.length === 0 && (
                    <p className="py-6 text-center text-muted-foreground">
                      No usage recorded yet. Counters start filling once a source search runs.
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
