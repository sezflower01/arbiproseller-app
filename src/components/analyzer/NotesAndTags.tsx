import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useAnalyzerNotes } from "@/hooks/use-analyzer-snapshot";
import { X } from "lucide-react";

export default function NotesAndTags({ asin, marketplace }: { asin: string; marketplace: string }) {
  const { notes, tags, saving, save } = useAnalyzerNotes(asin, marketplace);
  const [draft, setDraft] = useState("");
  const [tagDraft, setTagDraft] = useState("");
  const [localTags, setLocalTags] = useState<string[]>([]);

  useEffect(() => { setDraft(notes); setLocalTags(tags); }, [notes, tags]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Notes &amp; Tags</CardTitle>
      </CardHeader>
      <CardContent className="p-3 pt-0 space-y-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={3}
          placeholder="Notes about this product…"
          className="w-full rounded-md border bg-background p-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <div className="flex items-center gap-2 flex-wrap">
          {localTags.map((t) => (
            <Badge key={t} variant="secondary" className="gap-1">
              {t}
              <button onClick={() => setLocalTags(localTags.filter((x) => x !== t))} className="hover:text-destructive">
                <X className="w-3 h-3" />
              </button>
            </Badge>
          ))}
          <Input
            value={tagDraft}
            onChange={(e) => setTagDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && tagDraft.trim()) {
                e.preventDefault();
                if (!localTags.includes(tagDraft.trim())) setLocalTags([...localTags, tagDraft.trim()]);
                setTagDraft("");
              }
            }}
            placeholder="Add tag…"
            className="h-7 w-32 text-xs"
          />
        </div>
        <div className="flex justify-end">
          <Button size="sm" disabled={saving} onClick={() => save(draft, localTags)}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
