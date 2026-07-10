import { useState, useEffect, useCallback } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Search, ChevronRight, FolderOpen, Loader2, X, Database, RefreshCw } from "lucide-react";
import { invokeEdgeFunction } from "@/lib/edgeFunctionClient";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

interface Category {
  id: number;
  name: string;
  context_free_name?: string | null;
  parent_id?: number | null;
  is_root?: boolean;
  children_count?: number;
  product_count?: number;
}

interface CategorySelectorProps {
  marketplace: string;
  value: string; // category ID as string
  onChange: (categoryId: string, categoryName?: string) => void;
}

export default function CategorySelector({ marketplace, value, onChange }: CategorySelectorProps) {
  const [open, setOpen] = useState(false);
  const [rootCategories, setRootCategories] = useState<Category[]>([]);
  const [searchResults, setSearchResults] = useState<Category[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [loading, setLoading] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [searching, setSearching] = useState(false);
  const [selectedName, setSelectedName] = useState("");
  const { toast } = useToast();

  // Load root categories from Supabase on open
  const loadRoots = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('amazon_categories' as any)
        .select('id, name, context_free_name, parent_id, is_root, children_count, product_count')
        .eq('marketplace', marketplace)
        .eq('is_root', true)
        .eq('is_active', true)
        .order('name')
        .limit(200);

      if (error) throw error;
      setRootCategories((data as any[]) || []);
    } catch (e: any) {
      console.error('Failed to load categories:', e);
    } finally {
      setLoading(false);
    }
  }, [marketplace]);

  useEffect(() => {
    if (open) {
      loadRoots();
      setSearchResults([]);
      setSearchTerm("");
    }
  }, [open, loadRoots]);

  // Seed root categories
  const handleSeed = async () => {
    setSeeding(true);
    try {
      const result = await invokeEdgeFunction<{ seeded: number }>({
        functionName: "import-amazon-categories",
        body: { action: "seed", marketplace },
        maxRetries: 0,
      });
      if (result.ok) {
        toast({ title: "Categories seeded", description: `${result.data?.seeded} root categories added for ${marketplace}` });
        await loadRoots();
      } else {
        toast({ title: "Seed failed", description: result.errorMessage || "Failed to seed categories", variant: "destructive" });
      }
    } catch (e: any) {
      toast({ title: "Seed failed", description: e.message, variant: "destructive" });
    } finally {
      setSeeding(false);
    }
  };

  // Search categories via Keepa
  const handleSearch = async () => {
    if (!searchTerm || searchTerm.length < 2) return;
    setSearching(true);
    try {
      // First search locally
      const { data: localData } = await supabase
        .from('amazon_categories' as any)
        .select('id, name, context_free_name, parent_id, is_root, children_count, product_count')
        .eq('marketplace', marketplace)
        .eq('is_active', true)
        .ilike('name', `%${searchTerm}%`)
        .order('name')
        .limit(50);

      if (localData && (localData as any[]).length > 0) {
        setSearchResults(localData as any[]);
        setSearching(false);
        return;
      }

      // Fall back to Keepa search
      const result = await invokeEdgeFunction<{ categories: any[]; saved: number; tokensLeft?: number }>({
        functionName: "import-amazon-categories",
        body: { action: "search", marketplace, searchTerm },
        maxRetries: 0,
      });
      if (result.ok && result.data?.categories) {
        setSearchResults(result.data.categories.map((c: any) => ({
          id: c.id,
          name: c.name,
          context_free_name: c.contextFreeName,
          parent_id: c.parentId,
          is_root: c.isRoot,
          children_count: c.childrenCount,
          product_count: c.productCount,
        })));
        if (result.data.tokensLeft != null) {
          toast({ title: "Category search complete", description: `Found ${result.data.categories.length} categories. Tokens: ${result.data.tokensLeft}` });
        }
      } else {
        toast({ title: "Search failed", description: result.errorMessage || "No categories found", variant: "destructive" });
      }
    } catch (e: any) {
      toast({ title: "Search failed", description: e.message, variant: "destructive" });
    } finally {
      setSearching(false);
    }
  };

  const selectCategory = (cat: Category) => {
    onChange(String(cat.id), cat.name);
    setSelectedName(cat.name);
    setOpen(false);
  };

  const clearSelection = () => {
    onChange("", "");
    setSelectedName("");
  };

  // Resolve name for pre-set value
  useEffect(() => {
    if (value && !selectedName) {
      supabase
        .from('amazon_categories' as any)
        .select('name')
        .eq('id', Number(value))
        .single()
        .then(({ data }) => {
          if (data) setSelectedName((data as any).name);
        });
    }
  }, [value, selectedName]);

  const displayCategories = searchTerm && searchResults.length > 0 ? searchResults : rootCategories;

  return (
    <div className="flex items-center gap-1.5">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="h-8 text-xs justify-start gap-1.5 min-w-[180px] max-w-[300px]">
            <FolderOpen className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">
              {selectedName || (value ? `ID: ${value}` : "Select category…")}
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[380px] p-0" align="start">
          <div className="p-3 border-b space-y-2">
            <div className="flex gap-1.5">
              <Input
                placeholder="Search categories…"
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                onKeyDown={e => e.key === "Enter" && handleSearch()}
                className="h-8 text-xs"
                autoFocus
              />
              <Button size="sm" className="h-8 px-2" onClick={handleSearch} disabled={searching || searchTerm.length < 2}>
                {searching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
              </Button>
            </div>
            {rootCategories.length === 0 && !loading && (
              <Button variant="outline" size="sm" className="w-full h-7 text-xs gap-1" onClick={handleSeed} disabled={seeding}>
                {seeding ? <Loader2 className="h-3 w-3 animate-spin" /> : <Database className="h-3 w-3" />}
                Load {marketplace} root categories
              </Button>
            )}
          </div>

          <ScrollArea className="h-[300px]">
            {loading ? (
              <div className="flex items-center justify-center py-8 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading…
              </div>
            ) : displayCategories.length === 0 ? (
              <div className="text-center py-8 text-sm text-muted-foreground">
                {searchTerm ? "No categories found. Try Keepa search." : "No categories loaded yet."}
              </div>
            ) : (
              <div className="p-1">
                {displayCategories.map(cat => (
                  <button
                    key={cat.id}
                    className={`w-full flex items-center gap-2 px-3 py-2 rounded-md text-left text-sm hover:bg-accent transition-colors ${
                      String(cat.id) === value ? "bg-accent font-medium" : ""
                    }`}
                    onClick={() => selectCategory(cat)}
                  >
                    <FolderOpen className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <span className="flex-1 truncate">{cat.name}</span>
                    {cat.product_count != null && cat.product_count > 0 && (
                      <Badge variant="secondary" className="text-[10px] px-1.5 py-0 shrink-0">
                        {cat.product_count > 1000 ? `${Math.round(cat.product_count / 1000)}k` : cat.product_count}
                      </Badge>
                    )}
                    {cat.children_count != null && cat.children_count > 0 && (
                      <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
                    )}
                  </button>
                ))}
              </div>
            )}
          </ScrollArea>

          {value && (
            <div className="p-2 border-t">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Selected: {selectedName || value}</span>
                <Badge variant="outline" className="text-[10px]">ID: {value}</Badge>
              </div>
            </div>
          )}
        </PopoverContent>
      </Popover>

      {value && (
        <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={clearSelection}>
          <X className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}
