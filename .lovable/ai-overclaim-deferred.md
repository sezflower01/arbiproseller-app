# AI Overclaim — Deferred Marketing/Blog Rewrite

**Status:** Tool-page residuals fixed. Marketing + blog rewrite deferred pending two product decisions.
**Created:** 2026-07-04 (end of session)

## Backend reality (verified this session)

The Gemini pipeline **narrates, not steers**. Confirmed against production DB:

- `smart_engine_ai_reviews`: 84 rows/7d, **100% `accepted_status='pending'`** — nothing ever transitions to accepted/applied.
- `repricer_adaptations_log`: **0 rows in 30d** — the "Gemini changed a threshold" table has never been written.
- `repricer_ai_decisions`: 786K rows with `ai_model=NULL`, 190K `deterministic_v2`, **0 with any Gemini model**.
- `repricer-evaluate` edge fn: **never reads `ai_tuning_suggestion`**. Only `smart-engine-auto-review` (writer) and `AiActionInsights.tsx` (display) reference it.

**Manual-min-only floor is safe** because nothing downstream closes the loop. But every product surface claiming "Gemini reviews / tunes / makes the system smarter / real AI decisions" is currently false.

## Files still carrying overclaim language

### Marketing (product-facing, high visibility)
- `src/pages/AiRepricerProduct.tsx` — biggest single overclaim surface. "Gemini reviews your pricing decisions", "your system continuously gets smarter", "Real AI, Not a Black Box", "Powered by Google Gemini 2.5" hero + two-card section (Flash "reviews the majority of pricing decisions" / Pro "escalated for high-impact cases"), "Ready to let AI handle your pricing?"
- `src/components/Hero.tsx:62` — "Automate pricing with AI reviewed by Gemini to improve performance over time"
- `src/components/FinalCTA.tsx:11` — same line
- `src/components/AiBanner.tsx:36` — "Continuously improves your results with AI reviewed by Gemini"

### Blog posts (SEO-indexed)
- **`src/pages/BlogRealAiDecisions.tsx` — HIGHEST URGENCY.** Title, meta description, H1, and **JSON-LD structured data** all premised on "Real AI Pricing Decisions from Live Amazon ASINs". The JSON-LD makes the false claim **machine-readable** — Google and AI answer engines may be ingesting it as structured fact about the product. If this page is indexed, it is actively shaping how crawlers describe ArbiProSeller.
- `src/pages/BlogRepricerFeatures.tsx` — "No black box. Every decision is explainable." + "A real AI system … gets smarter every day"
- `src/pages/BlogAiRepricer.tsx` — "Not as hidden behavior. Not as a black box."
- `src/pages/BlogAiRepricerLooksAt.tsx` — "A real AI system understands the situation…"
- `src/pages/BlogWhatRepricerDoes.tsx` — "No black box behavior."
- `src/pages/BlogTwoSellersOneAsin.tsx`, `src/pages/BlogProductLibrary.tsx` — cross-link cards to "Real AI Decisions from Live ASINs"

### Cross-links pointing at the blog post
- `public/llms.txt:24`
- `src/components/Footer.tsx:111`
- `src/components/navbar/NavbarLinks.tsx:122`
- `src/components/navbar/NavbarMobileMenu.tsx:17`

## Blocking decisions (must be answered BEFORE any rewrite)

### Decision 1: Option 2 direction — will Gemini ever actually influence pricing?
Two possible product shapes, and each dictates different marketing copy:

- **(a) Build Option 2 later.** Wire `smart-engine-apply-tuning` to flip `accepted_status`, log to `repricer_adaptations_log`, have `repricer-evaluate` read a narrow whitelist of tag types (e.g. only `extend_cooldown`), with kill-switch + per-ASIN audit. Marketing rewrite should read accurately today but not need a second rewrite once wired.
- **(b) "Rules + AI observations" is permanent.** Legitimate, sellable positioning ("deterministic, auditable pricing with AI-assisted insight" — many buyers trust deterministic systems more than opaque AI). Marketing rewrite leans into that as a feature, not a limitation.

**Do not touch marketing copy until this is decided.** Softening a subset creates inconsistent claims across the site (worse than either fully-honest or fully-overclaimed).

### Decision 2: `BlogRealAiDecisions.tsx` — noindex/unpublish now, or wait for rewrite?
The JSON-LD structured data argues for urgency. Options:
- Add `<meta name="robots" content="noindex,nofollow" />` and remove from sitemap.xml immediately, keep page live until rewrite ships.
- Fully unpublish (route removed, cross-links removed from Footer/Navbar/llms.txt).
- Leave live pending rewrite (higher risk the longer it sits).

## What was fixed this session (do NOT re-fix)

- `src/pages/tools/AiActionInsights.tsx` — Sort dropdown → "Sort: AI-observed first"; internal comments updated.
- `src/components/repricer/SmartEngineLearning.tsx` — "AI-Reviewed Cases" tile → "AI-Observed Cases".
- Earlier in session: `AiInsightsCard.tsx`, `AiInsightsLiveState.tsx`, `AiActionInsights.tsx` reframed (page renamed to "Repricer Action Log", "Fully Transparent AI" → "Rules-driven pricing", "AI-Reviewed" → "AI-Observed", tooltips explicitly state Gemini notes did not affect the decision).

## Approved next-session order
1. Decide Option 2 direction (permanent vs eventual wiring).
2. Decide `BlogRealAiDecisions.tsx` fate (noindex/unpublish now vs wait).
3. Only then: full marketing + blog rewrite with tone instructions.
