import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Loader2, Plus, X } from "lucide-react";
import {
  useQualificationExclusions,
  normalizeTerm,
  type ExclusionKind,
  type PreviewEntry,
  type ExcludedTerm,
} from "@/hooks/use-qualification-exclusions";
import { useToast } from "@/hooks/use-toast";

// State is passed down rather than each list calling the hook itself: two
// independent hook instances would each hold their own copy of the terms and
// counts, so adding a brand would leave the category list showing stale
// numbers until a reload.
function ExclusionList({
  kind,
  title,
  blurb,
  placeholder,
  suggestions,
  terms,
  busy,
  add,
  remove,
  impactOf,
}: {
  kind: ExclusionKind;
  title: string;
  blurb: string;
  placeholder: string;
  suggestions: PreviewEntry[];
  terms: ExcludedTerm[];
  busy: boolean;
  add: (kind: ExclusionKind, raw: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  impactOf: (kind: ExclusionKind, value: string) => number | null;
}) {
  const [draft, setDraft] = useState("");
  const { toast } = useToast();

  const mine = terms.filter((t) => t.kind === kind);
  const excluded = new Set(mine.map((t) => t.value));
  // Values present in the listings that are NOT yet excluded — the honest
  // shortlist, since a rule for something you have none of does nothing.
  const available = suggestions.filter((s) => !excluded.has(s.value)).slice(0, 12);
  const draftImpact = draft.trim() ? impactOf(kind, normalizeTerm(draft)) : null;

  const guard = (p: Promise<unknown>) =>
    p.catch((e) => toast({ title: "Could not save", description: (e as Error).message, variant: "destructive" }));

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        <span className="text-xs text-muted-foreground">{mine.length} excluded</span>
      </div>
      <p className="text-xs text-muted-foreground">{blurb}</p>

      {mine.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {mine.map((t) => {
            const n = impactOf(kind, t.value);
            return (
              <Badge key={t.id} variant="secondary" className="gap-1 pr-1 font-normal">
                {t.label || t.value}
                {/* What this rule is holding back right now. Absent when the
                    value does not appear in the user's listings at all. */}
                {n !== null && <span className="text-muted-foreground">· {n}</span>}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => guard(remove(t.id))}
                  className="rounded-sm hover:text-destructive disabled:opacity-50"
                  aria-label={`Stop excluding ${t.label || t.value}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            );
          })}
        </div>
      )}

      {available.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">In your listings — click to exclude:</p>
          <div className="flex flex-wrap gap-1.5">
            {available.map((s) => (
              <button
                key={s.value}
                type="button"
                disabled={busy}
                onClick={() => guard(add(kind, s.label))}
                className="rounded-full border border-dashed px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50"
              >
                {s.label} · {s.n}
              </button>
            ))}
          </div>
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!draft.trim()) return;
          guard(add(kind, draft).then(() => setDraft("")));
        }}
        className="flex gap-2"
      >
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder}
          className="h-9 text-sm"
          disabled={busy}
        />
        <Button type="submit" size="sm" variant="secondary" disabled={busy || !draft.trim()}>
          <Plus className="h-3.5 w-3.5 mr-1" /> Exclude
        </Button>
      </form>

      {/* Impact BEFORE saving, which is the whole point of the preview. */}
      {draft.trim() && (
        <p className="text-xs text-muted-foreground">
          {draftImpact === null
            ? `No current listings match "${draft.trim()}" — this rule would affect nothing today.`
            : `Would exclude ${draftImpact.toLocaleString()} current listing${draftImpact === 1 ? "" : "s"}.`}
        </p>
      )}
    </div>
  );
}

/**
 * Category and brand rules for auto-source qualification.
 *
 * Both lists ship seeded with the values that used to be hardcoded, so
 * behaviour is unchanged until edited. Matching is exact, case-insensitive and
 * trimmed — never substring: "Publisher Unknown" is a real publisher, and a
 * contains-"unknown" rule would wrongly reject it.
 */
export default function QualificationExclusionsPanel() {
  const { terms, categoryCounts, brandCounts, loading, busy, add, remove, impactOf } =
    useQualificationExclusions();
  const shared = { terms, busy, add, remove, impactOf };

  return (
    <Card>
      <CardContent className="p-4 space-y-5">
        <div>
          <h2 className="text-sm font-semibold">Never auto-search these</h2>
          <p className="text-xs text-muted-foreground mt-1">
            Listings matching these are detected and shown, but never spend a source search.
            Matching is exact — "Generic" is excluded, "Generic Electric" is not.
          </p>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-3">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
          </div>
        ) : (
          <>
            <ExclusionList
              kind="category"
              title="Categories"
              blurb="Amazon's own category names, which are often not what you would call them — 'DVD' and 'Video' rather than 'Movies & TV'. The counts show what each rule holds back in your listings; Amazon's categories are coarse, so check before adding."
              placeholder="e.g. Video Games"
              suggestions={categoryCounts}
              {...shared}
            />
            <div className="border-t" />
            <ExclusionList
              kind="brand"
              title="Brands"
              blurb="Placeholder brands worth skipping. A listing with no brand at all is never excluded by these — a missing brand usually means Amazon had no data, not that the product is unbranded."
              placeholder="e.g. Generic"
              suggestions={brandCounts}
              {...shared}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}
