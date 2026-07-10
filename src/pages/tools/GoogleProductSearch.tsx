import { useState } from "react";
import { Helmet } from "react-helmet-async";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Search, ExternalLink, Loader2, ShoppingCart, Copy, ClipboardCheck } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

interface ProductInfo {
  asin: string;
  title: string;
  image_url: string | null;
}

const GoogleProductSearch = () => {
  const [asin, setAsin] = useState("");
  const [loading, setLoading] = useState(false);
  const [product, setProduct] = useState<ProductInfo | null>(null);
  const { toast } = useToast();

  const handleSearch = async () => {
    const trimmed = asin.trim().toUpperCase();
    if (!trimmed) {
      toast({ title: "Enter an ASIN", variant: "destructive" });
      return;
    }
    setLoading(true);
    setProduct(null);
    try {
      // Try inventory first
      const { data: inv } = await supabase
        .from("inventory")
        .select("asin, title, image_url")
        .eq("asin", trimmed)
        .limit(1)
        .maybeSingle();

      if (inv?.title) {
        setProduct({ asin: trimmed, title: inv.title, image_url: inv.image_url });
        return;
      }

      // Try sales_orders
      const { data: sale } = await supabase
        .from("sales_orders")
        .select("asin, title, image_url")
        .eq("asin", trimmed)
        .not("title", "is", null)
        .limit(1)
        .maybeSingle();

      if (sale?.title) {
        setProduct({ asin: trimmed, title: sale.title, image_url: sale.image_url });
        return;
      }

      // Try created_listings
      const { data: listing } = await supabase
        .from("created_listings")
        .select("asin, title, image_url")
        .eq("asin", trimmed)
        .limit(1)
        .maybeSingle();

      if (listing?.title) {
        setProduct({ asin: trimmed, title: listing.title, image_url: listing.image_url });
        return;
      }

      // Nothing found locally – still show the ASIN with Google link
      setProduct({ asin: trimmed, title: trimmed, image_url: null });
      toast({ title: "ASIN not in your data", description: "You can still search Google directly." });
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const googleSearchUrl = (query: string) =>
    `https://www.google.com/search?q=${encodeURIComponent(query)}&gl=us&hl=en`;

  return (
    <div className="min-h-screen flex flex-col">
      <Helmet>
        <title>Google Product Search | ArbiProSeller</title>
        <meta name="description" content="Look up an ASIN and search Google Shopping for the product" />
      </Helmet>
      <Navbar />
      <main className="flex-grow pt-24 pb-12">
        <div className="container mx-auto px-4 max-w-2xl">
          <h1 className="text-4xl font-bold mb-2">Google Product Search</h1>
          <p className="text-muted-foreground mb-8">Enter an ASIN to look up the product and search Google Shopping</p>

          <div className="flex gap-2 mb-8">
            <Input
              placeholder="e.g. B08BYX3C46"
              value={asin}
              onChange={(e) => setAsin(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              className="max-w-xs font-mono"
            />
            <Button onClick={handleSearch} disabled={loading}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Search className="h-4 w-4 mr-2" />}
              Search
            </Button>
          </div>

          {product && (
            <Card className="p-6 flex gap-6 items-start">
              {product.image_url && (
                <img
                  src={product.image_url}
                  alt={product.title}
                  className="w-28 h-28 object-contain rounded-lg border bg-muted shrink-0"
                />
              )}
              <div className="flex-1 min-w-0 space-y-3">
                <a
                  href={googleSearchUrl(product.title)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-lg font-semibold text-primary hover:underline inline-flex items-start gap-1 leading-snug"
                >
                  {product.title}
                  <ExternalLink className="h-4 w-4 mt-0.5 shrink-0" />
                </a>

                <div className="text-sm text-muted-foreground font-mono">{product.asin}</div>

                <div className="flex flex-wrap gap-2 pt-1">
                  <Button
                    size="sm"
                    variant="default"
                    onClick={() => {
                      const url = googleSearchUrl(product.title);
                      const win = window.open(url, "_blank", "noopener,noreferrer");
                      if (!win) {
                        navigator.clipboard.writeText(url);
                        toast({ title: "Link copied!", description: "Popup blocked — paste the link in a new browser tab." });
                      }
                    }}
                  >
                    <Search className="h-4 w-4 mr-1" />
                    Search on Google
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      navigator.clipboard.writeText(product.title);
                      toast({ title: "Title copied to clipboard" });
                    }}
                  >
                    <Copy className="h-4 w-4 mr-1" />
                    Copy Title
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      navigator.clipboard.writeText(googleSearchUrl(product.title));
                      toast({ title: "Google search link copied to clipboard" });
                    }}
                  >
                    <ClipboardCheck className="h-4 w-4 mr-1" />
                    Copy Google Link
                  </Button>
                  <a
                    href={`https://www.amazon.com/dp/${product.asin}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <Button size="sm" variant="outline">
                      Amazon Listing
                      <ExternalLink className="h-3.5 w-3.5 ml-1" />
                    </Button>
                  </a>
                </div>
              </div>
            </Card>
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
};

export default GoogleProductSearch;
