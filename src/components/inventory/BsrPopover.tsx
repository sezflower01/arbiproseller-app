import { useState } from "react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Loader2, TrendingUp, RefreshCw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";

interface BsrPopoverProps {
  asin: string;
  currentBsr: number | null;
  onBsrUpdate?: (asin: string, bsr: number) => void;
}

export function BsrPopover({ asin, currentBsr, onBsrUpdate }: BsrPopoverProps) {
  const [loading, setLoading] = useState(false);
  const [bsr, setBsr] = useState<number | null>(currentBsr);
  const [category, setCategory] = useState<string | null>(null);
  const [lastFetched, setLastFetched] = useState<Date | null>(null);
  const [open, setOpen] = useState(false);

  const fetchBsr = async () => {
    setLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        throw new Error("Not authenticated");
      }

      const response = await supabase.functions.invoke('fetch-bsr', {
        body: { asin },
        headers: { Authorization: `Bearer ${session.access_token}` }
      });

      if (response.error) throw response.error;

      if (response.data?.bsr) {
        setBsr(response.data.bsr);
        setCategory(response.data.category || null);
        setLastFetched(new Date());
        onBsrUpdate?.(asin, response.data.bsr);
        toast({
          title: "BSR updated",
          description: `Rank #${response.data.bsr.toLocaleString()}${response.data.category ? ` in ${response.data.category}` : ''}`,
        });
      } else {
        toast({
          title: "BSR not available",
          description: "This product may not have a Best Seller Rank.",
        });
      }
    } catch (error: any) {
      console.error("BSR fetch error:", error);
      toast({
        variant: "destructive",
        title: "Failed to fetch BSR",
        description: error?.message || "Could not retrieve BSR data.",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="text-xs hover:underline cursor-pointer focus:outline-none focus:ring-1 focus:ring-primary rounded px-1"
          onClick={() => setOpen(true)}
        >
          {bsr !== null ? (
            <span className="font-medium">{bsr.toLocaleString()}</span>
          ) : (
            <span className="text-muted-foreground hover:text-foreground">—</span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-4 bg-popover border border-border shadow-lg z-50" align="center">
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-primary" />
            <span className="font-semibold text-sm">Best Seller Rank</span>
          </div>
          
          <div className="text-center py-2">
            {bsr !== null ? (
              <div>
                <span className="text-2xl font-bold text-foreground">#{bsr.toLocaleString()}</span>
                {category && (
                  <p className="text-xs text-muted-foreground mt-1">in {category}</p>
                )}
                {lastFetched && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Updated: {lastFetched.toLocaleTimeString()}
                  </p>
                )}
              </div>
            ) : (
              <p className="text-muted-foreground text-sm">Click below to fetch BSR</p>
            )}
          </div>

          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={fetchBsr}
            disabled={loading}
          >
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Fetching...
              </>
            ) : (
              <>
                <RefreshCw className="w-4 h-4 mr-2" />
                {bsr !== null ? "Refresh BSR" : "Fetch BSR"}
              </>
            )}
          </Button>

          <p className="text-xs text-muted-foreground text-center">
            ASIN: {asin}
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
