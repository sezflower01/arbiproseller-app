import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  ExternalLink, Star, Trash2, Pencil, Check, X, RefreshCw, Loader2,
} from "lucide-react";
import {
  SavedSource, fmtPrice, fmtRelative, freshnessOf, freshnessLabel, toneClass,
} from "./shared";

interface Props {
  saved: SavedSource[];
  recheckingId?: string | null;
  onUnsave: (url: string) => void;
  onTogglePreferred: (s: SavedSource) => void;
  onUpdateNotes: (s: SavedSource, notes: string) => void;
  onRecheck?: (s: SavedSource) => void;
}

export default function SavedSourcesPanel({
  saved, recheckingId, onUnsave, onTogglePreferred, onUpdateNotes, onRecheck,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  if (saved.length === 0) return null;

  const sorted = [...saved].sort((a, b) => {
    const ap = a.is_preferred ? 1 : 0;
    const bp = b.is_preferred ? 1 : 0;
    if (ap !== bp) return bp - ap;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  return (
    <Card className="p-5 bg-card/50 backdrop-blur border-border/50 mb-6">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-white">
          Saved sources for this ASIN ({saved.length})
        </h2>
      </div>
      <div className="space-y-2">
        {sorted.map((s) => {
          const isEditing = editingId === s.id;
          const isRechecking = recheckingId === s.id;
          const fresh = freshnessOf(s.last_checked_at);
          const freshMeta = freshnessLabel(fresh);

          // Status of last recheck
          const status = s.last_status; // extracted | blocked | unresolved | invalid
          const statusBadge = (() => {
            if (!status) return null;
            if (status === "extracted") return { label: "Still valid", tone: "good" as const };
            if (status === "blocked") return { label: "Blocked now", tone: "bad" as const };
            if (status === "unresolved") return { label: "Unresolved", tone: "ai" as const };
            if (status === "invalid") return { label: "Invalid page", tone: "bad" as const };
            return null;
          })();

          return (
            <div
              key={s.id}
              className={`p-3 rounded border ${
                s.is_preferred
                  ? "bg-amber-500/10 border-amber-500/40"
                  : "bg-muted/10 border-border/30"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    {s.is_preferred && (
                      <Badge variant="outline" className="bg-amber-500/15 text-amber-300 border-amber-500/30">
                        <Star className="h-3 w-3 mr-1 fill-current" /> Preferred
                      </Badge>
                    )}
                    {statusBadge && (
                      <Badge variant="outline" className={toneClass(statusBadge.tone)}>
                        {statusBadge.label}
                      </Badge>
                    )}
                    <Badge variant="outline" className={toneClass(freshMeta.tone)}>
                      {freshMeta.label}
                    </Badge>
                    <a
                      href={s.source_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-white hover:text-primary text-sm line-clamp-1 break-all"
                    >
                      {s.source_title || s.source_url}
                    </a>
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-3 flex-wrap">
                    <span>{s.domain}</span>
                    <span>· last checked {fmtRelative(s.last_checked_at || s.created_at)}</span>
                    {s.last_confidence != null && (
                      <span>· confidence {Math.round(s.last_confidence * 100)}%</span>
                    )}
                  </div>
                  {!isEditing && s.notes && (
                    <div className="text-xs text-muted-foreground mt-2 italic">"{s.notes}"</div>
                  )}
                  {isEditing && (
                    <div className="flex items-center gap-1 mt-2">
                      <Input
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        placeholder="Add a note (e.g. needs login, ships fast)…"
                        className="h-7 text-xs"
                        autoFocus
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => { onUpdateNotes(s, draft); setEditingId(null); }}
                      >
                        <Check className="h-3 w-3 text-emerald-400" />
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                        <X className="h-3 w-3" />
                      </Button>
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-3 flex-shrink-0">
                  <span className="font-mono text-emerald-300 text-sm">{fmtPrice(s.price, s.currency)}</span>
                  {onRecheck && (
                    <Button
                      size="sm"
                      variant="ghost"
                      title="Recheck price now"
                      onClick={() => onRecheck(s)}
                      disabled={isRechecking}
                    >
                      {isRechecking
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        : <RefreshCw className="h-3.5 w-3.5" />}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    title={s.is_preferred ? "Unmark preferred" : "Mark as preferred"}
                    onClick={() => onTogglePreferred(s)}
                  >
                    <Star className={`h-3.5 w-3.5 ${s.is_preferred ? "fill-amber-400 text-amber-400" : ""}`} />
                  </Button>
                  {!isEditing && (
                    <Button
                      size="sm"
                      variant="ghost"
                      title="Edit notes"
                      onClick={() => { setEditingId(s.id); setDraft(s.notes || ""); }}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" asChild>
                    <a href={s.source_url} target="_blank" rel="noopener noreferrer">
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    title="Remove"
                    onClick={() => onUnsave(s.source_url)}
                  >
                    <Trash2 className="h-3.5 w-3.5 text-rose-400" />
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
