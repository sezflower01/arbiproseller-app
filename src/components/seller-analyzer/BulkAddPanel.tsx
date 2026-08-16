import { useRef, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Upload, ListPlus, AlertTriangle, Check } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { formatDuration, estimateWatchTiming, type BulkAddResult } from "@/hooks/use-seller-watchlist";

interface BulkAddPanelProps {
  marketplace: string;
  currentWatchCount: number;
  onBulkAdd: (text: string, marketplace: string, mode: "preview" | "commit") => Promise<BulkAddResult>;
}

function SummaryRow({ label, value, tone }: { label: string; value: number; tone?: "good" | "warn" | "muted" }) {
  const valueClass =
    tone === "good" ? "text-emerald-600 dark:text-emerald-400 font-semibold"
    : tone === "warn" ? "text-amber-600 dark:text-amber-400 font-semibold"
    : "text-muted-foreground";
  return (
    <div className="flex items-baseline justify-between gap-4 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={valueClass}>{value.toLocaleString()}</span>
    </div>
  );
}

export default function BulkAddPanel({ marketplace, currentWatchCount, onBulkAdd }: BulkAddPanelProps) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<BulkAddResult | null>(null);
  const [busy, setBusy] = useState<"preview" | "commit" | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Reading a CSV into the same textarea keeps ONE input path: what you see
  // is exactly what gets parsed, and a file can be edited before committing
  // rather than being an opaque blob.
  const onFile = async (file: File) => {
    try {
      const contents = await file.text();
      setText(contents);
      setPreview(null);
      toast({ title: `Loaded ${file.name}`, description: "Review the list, then preview." });
    } catch (e: any) {
      toast({ title: "Could not read file", description: e.message, variant: "destructive" });
    }
  };

  const runPreview = async () => {
    setBusy("preview");
    try {
      setPreview(await onBulkAdd(text, marketplace, "preview"));
    } catch (e: any) {
      toast({ title: "Preview failed", description: e.message, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  const runCommit = async () => {
    setBusy("commit");
    try {
      const result = await onBulkAdd(text, marketplace, "commit");
      const total = (result.added ?? 0) + (result.reactivated ?? 0);
      toast({
        title: `Added ${total.toLocaleString()} seller${total === 1 ? "" : "s"}`,
        description: result.partial ? "Some rows failed — see the summary." : undefined,
        variant: result.partial ? "destructive" : undefined,
      });
      setPreview(result);
      if (!result.partial) setText("");
    } catch (e: any) {
      toast({ title: "Bulk add failed", description: e.message, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  if (!open) {
    return (
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <ListPlus className="h-4 w-4 mr-2" /> Bulk add sellers
      </Button>
    );
  }

  // Count what is actually in the box, client-side. Without this the only
  // line count came back from the server AFTER previewing, so a truncated
  // paste was indistinguishable from a filter that legitimately matched
  // fewer sellers -- you had to diff two numbers you could not see side by
  // side. Showing it up front makes a short paste obvious before anything
  // is sent.
  const localLineCount = text.split(/\r?\n/).filter((l) => l.trim()).length;
  const serverLineCount = preview?.linesRead;
  const countMismatch = serverLineCount !== undefined && serverLineCount !== localLineCount;

  const willChange = preview ? preview.willAdd + preview.willReactivate : 0;
  // Show the wait BEFORE committing. Adding 1000 sellers legitimately means a
  // multi-day seeding queue, and that should be a known trade-off at the
  // moment of choosing, not a surprise discovered a week later.
  const projected = estimateWatchTiming(currentWatchCount + willChange);

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">Bulk add sellers · {marketplace}</h2>
          <Button type="button" variant="ghost" size="sm" onClick={() => { setOpen(false); setPreview(null); }}>
            Close
          </Button>
        </div>

        <Textarea
          value={text}
          onChange={(e) => { setText(e.target.value); setPreview(null); }}
          rows={8}
          placeholder={"One per line — seller IDs, storefront URLs, or CSV rows:\nA1B0EBOAJDDILW\nhttps://www.amazon.com/sp?me=A221MUUT57POIV\nA1JGL3QS3PG2RX,Some Store"}
          className="font-mono text-xs"
        />

        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.txt"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }}
          />
          <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
            <Upload className="h-4 w-4 mr-2" /> Load .csv
          </Button>
          <Button type="button" size="sm" onClick={runPreview} disabled={!text.trim() || busy !== null}>
            {busy === "preview" ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
            Preview
          </Button>
          <span className="text-xs text-muted-foreground">
            {localLineCount > 0 && (
              <><strong>{localLineCount.toLocaleString()}</strong> line{localLineCount === 1 ? "" : "s"} in the box · </>
            )}
            All rows are added to <strong>{marketplace}</strong>. Max 1,000 per upload.
          </span>
        </div>

        {preview && (
          <div className="rounded-lg border p-3 space-y-2">
            <div className="text-sm font-medium">
              {preview.committed ? "Result" : "Preview"} · {preview.linesRead.toLocaleString()} lines read
            </div>

            {countMismatch && (
              <div className="flex items-start gap-2 text-xs text-amber-600 dark:text-amber-400">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <span>
                  The box holds {localLineCount.toLocaleString()} lines but the server read{" "}
                  {serverLineCount?.toLocaleString()} — the upload was truncated in transit, so this
                  preview is incomplete. Re-load the file rather than trusting these counts.
                </span>
              </div>
            )}

            <SummaryRow label={preview.committed ? "Added" : "Will add"} value={preview.committed ? (preview.added ?? 0) : preview.willAdd} tone="good" />
            {(preview.willReactivate > 0 || (preview.reactivated ?? 0) > 0) && (
              <SummaryRow label={preview.committed ? "Reactivated" : "Will reactivate"} value={preview.committed ? (preview.reactivated ?? 0) : preview.willReactivate} tone="good" />
            )}
            {preview.alreadyWatched > 0 && <SummaryRow label="Already watching (skipped)" value={preview.alreadyWatched} />}
            {preview.duplicatesInUpload > 0 && <SummaryRow label="Duplicates in upload" value={preview.duplicatesInUpload} />}
            {preview.invalidLines > 0 && <SummaryRow label="Unrecognised lines" value={preview.invalidLines} tone="warn" />}

            {preview.overCap && (
              <div className="flex items-start gap-2 text-xs text-amber-600 dark:text-amber-400">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <span>
                  Over the {preview.cap.toLocaleString()} cap — {preview.droppedOverCap.toLocaleString()} entries
                  beyond the limit were dropped. Upload the rest separately.
                </span>
              </div>
            )}

            {preview.samples.invalid.length > 0 && (
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">Show unrecognised lines</summary>
                <ul className="mt-1 space-y-0.5 font-mono">
                  {preview.samples.invalid.map((l, i) => <li key={i} className="truncate">{l}</li>)}
                </ul>
              </details>
            )}

            {!preview.committed && willChange > 0 && (
              <div className="pt-1 space-y-2">
                <p className="text-xs text-muted-foreground">
                  After this you'll watch {(currentWatchCount + willChange).toLocaleString()} sellers.
                  Sellers are checked oldest-first, so a full rotation will take{" "}
                  <strong>{formatDuration(projected.rotationDays)}</strong> and a newly added seller's
                  first alert is possible in <strong>{formatDuration(projected.daysToFirstAlert)}</strong>.
                </p>
                <Button type="button" size="sm" onClick={runCommit} disabled={busy !== null}>
                  {busy === "commit" ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Check className="h-4 w-4 mr-2" />}
                  Confirm — add {willChange.toLocaleString()} seller{willChange === 1 ? "" : "s"}
                </Button>
              </div>
            )}

            {!preview.committed && willChange === 0 && (
              <p className="text-xs text-muted-foreground">Nothing new to add from this list.</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
