import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Radar, Copy } from "lucide-react";

export default function ProbeListingsIssuesButton() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string>("");

  const run = async () => {
    setLoading(true);
    setResult("");
    setOpen(true);
    try {
      const { data, error } = await supabase.functions.invoke("probe-listings-issues", {
        body: {},
      });
      if (error) throw error;
      setResult(JSON.stringify(data, null, 2));
    } catch (e: any) {
      setResult(`ERROR: ${e?.message || e}`);
      toast.error("Probe failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={run}
        disabled={loading}
        className="h-10 bg-white/60 backdrop-blur-sm border-white/20 text-[hsl(221,90%,22%)] font-bold gap-1"
      >
        <Radar className="h-3.5 w-3.5" />
        {loading ? "Probing…" : "Probe Suppressions"}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-4xl max-h-[85vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center justify-between gap-2">
              <span>Listings Issues Probe — raw SP-API response</span>
              {result && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    navigator.clipboard.writeText(result);
                    toast.success("Copied");
                  }}
                >
                  <Copy className="h-3.5 w-3.5 mr-1" /> Copy JSON
                </Button>
              )}
            </DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-auto">
            {loading && !result ? (
              <div className="text-sm text-muted-foreground p-4">
                Calling getListingsItem for up to 5 enabled SKUs per marketplace… ~15–30s.
              </div>
            ) : (
              <pre className="text-xs bg-black/90 text-green-300 p-4 rounded overflow-auto whitespace-pre-wrap break-all">
                {result || "No result yet"}
              </pre>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
