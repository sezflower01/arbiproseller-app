import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { Plus, CalendarIcon, DollarSign, Trash2 } from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useHomeMarketplace } from "@/hooks/use-home-marketplace";
import { toast } from "sonner";

// Accounting-grade "Other Expenses" categories — InventoryLab style.
// All entries roll up under "Other Expenses" in the P&L report.
// Order matches what users typically file on Schedule C.
const IRS_CATEGORIES = [
  "Salary",
  "Independent Contractors",
  "Rent",
  "Internet Service",
  "Utilities",
  "Subscriptions",
  "Amazon Pro Subscription",
  "Professional Services",
  "Insurance",
  "Medical Insurance",
  "Supplies",
  "Mileage",
  "Damage / Loss",
  "Interest",
  "Shipping Expenses",
  "Inbound Transportation Fee",
  "Liquidations",
  "Other"
];

const CURRENCIES = [
  { code: "USD", symbol: "$" },
  { code: "CAD", symbol: "C$" },
  { code: "EUR", symbol: "€" },
  { code: "GBP", symbol: "£" },
  { code: "INR", symbol: "₹" },
  { code: "JPY", symbol: "¥" },
  { code: "CHF", symbol: "₣" },
  { code: "HKD", symbol: "HK$" },
  { code: "SEK", symbol: "kr" },
  { code: "NOK", symbol: "kr" },
  { code: "RUB", symbol: "₽" },
  { code: "AED", symbol: "د." },
  { code: "PLN", symbol: "zł" },
  { code: "BRL", symbol: "R$" },
  { code: "TRY", symbol: "₺" },
  { code: "SAR", symbol: "﷼" },
  { code: "EGP", symbol: "E£" },
  { code: "MYR", symbol: "M$" },
  { code: "MVR", symbol: ".ރ" },
  { code: "PKR", symbol: "₨." },
  { code: "AUD", symbol: "A$" },
  { code: "SGD", symbol: "S$" },
  { code: "CNY", symbol: "¥" },
  { code: "ZAR", symbol: "R" }
];

const FREQUENCIES = [
  { value: "one_time", label: "One-Time" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Quarterly" },
  { value: "half_yearly", label: "Half-yearly" },
  { value: "annually", label: "Annually" }
];

const MARKETPLACES = [
  { value: "all", label: "All marketplaces" },
  { value: "amazon.com", label: "Amazon.com" },
  { value: "amazon.ca", label: "Amazon.ca" },
  { value: "amazon.com.mx", label: "Amazon.com.mx" },
  { value: "amazon.com.br", label: "Amazon.com.br" },
  { value: "amazon.co.uk", label: "Amazon.co.uk" },
  { value: "amazon.de", label: "Amazon.de" },
  { value: "amazon.fr", label: "Amazon.fr" },
  { value: "amazon.it", label: "Amazon.it" },
  { value: "amazon.es", label: "Amazon.es" }
];

interface Expense {
  id: string;
  name: string | null;
  amount: number;
  currency: string;
  frequency: string;
  expense_date: string;
  category: string;
  marketplace: string | null;
  description: string | null;
  is_advertising_cost: boolean;
}

interface ExpenseDialogProps {
  onExpenseAdded?: () => void;
}

export function ExpenseDialog({ onExpenseAdded }: ExpenseDialogProps) {
  const { user } = useAuth();
  const { homeCurrency, homeCurrencySymbol } = useHomeMarketplace();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [customCategories, setCustomCategories] = useState<{ id: string; name: string }[]>([]);
  const [showAddCategory, setShowAddCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");

  // Form state
  const [expenseName, setExpenseName] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [frequency, setFrequency] = useState("one_time");
  const [expenseDate, setExpenseDate] = useState<Date>(new Date());
  const [hasEndDate, setHasEndDate] = useState(false);
  const [endDate, setEndDate] = useState<Date | undefined>(undefined);
  const [category, setCategory] = useState("");
  const [marketplace, setMarketplace] = useState("all");
  const [description, setDescription] = useState("");
  const [isAdvertisingCost, setIsAdvertisingCost] = useState(false);

  useEffect(() => {
    if (open && user) {
      fetchExpenses();
      fetchCustomCategories();
    }
  }, [open, user]);

  // Auto-detect and lock currency to the seller's home marketplace currency.
  useEffect(() => {
    if (homeCurrency) setCurrency(homeCurrency);
  }, [homeCurrency]);

  const fetchExpenses = async () => {
    if (!user) return;
    const { data, error } = await supabase
      .from("expenses")
      .select("*")
      .eq("user_id", user.id)
      .order("expense_date", { ascending: false });
    
    if (!error && data) {
      setExpenses(data as Expense[]);
    }
  };

  const fetchCustomCategories = async () => {
    if (!user) return;
    const { data, error } = await supabase
      .from("expense_categories")
      .select("*")
      .or(`user_id.is.null,user_id.eq.${user.id}`)
      .order("name");
    
    if (!error && data) {
      setCustomCategories(data);
    }
  };

  const handleAddCategory = async () => {
    if (!user || !newCategoryName.trim()) return;
    
    const { data, error } = await supabase
      .from("expense_categories")
      .insert({ user_id: user.id, name: newCategoryName.trim() })
      .select()
      .single();
    
    if (error) {
      toast.error("Failed to add category");
      return;
    }
    
    setCustomCategories([...customCategories, data]);
    setCategory(newCategoryName.trim());
    setNewCategoryName("");
    setShowAddCategory(false);
    toast.success("Category added");
  };

  const handleDeleteCategory = async (categoryId: string, categoryName: string) => {
    if (!user) return;
    
    const { error } = await supabase
      .from("expense_categories")
      .delete()
      .eq("id", categoryId)
      .eq("user_id", user.id);
    
    if (error) {
      toast.error("Failed to delete category");
      return;
    }
    
    setCustomCategories(customCategories.filter(c => c.id !== categoryId));
    if (category === categoryName) {
      setCategory("");
    }
    toast.success("Category deleted");
  };

  const handleSubmit = async () => {
    if (!user || !amount || !category) {
      toast.error("Please fill in required fields");
      return;
    }

    setLoading(true);
    // Cast to any to allow the new columns that are not yet in generated types
    const { error } = await supabase.from("expenses").insert({
      user_id: user.id,
      name: expenseName || null,
      amount: parseFloat(amount),
      currency,
      frequency,
      expense_date: format(expenseDate, "yyyy-MM-dd"),
      end_date: hasEndDate && endDate ? format(endDate, "yyyy-MM-dd") : null,
      category,
      marketplace: marketplace === "all" ? null : marketplace,
      description: description || null,
      is_advertising_cost: isAdvertisingCost
    } as any);

    setLoading(false);

    if (error) {
      toast.error("Failed to add expense");
      return;
    }

    toast.success("Expense added");
    resetForm();
    fetchExpenses();
    onExpenseAdded?.();
  };

  const handleDelete = async (id: string) => {
    const { error } = await supabase.from("expenses").delete().eq("id", id);
    if (error) {
      toast.error("Failed to delete expense");
      return;
    }
    toast.success("Expense deleted");
    fetchExpenses();
    onExpenseAdded?.();
  };

  const resetForm = () => {
    setExpenseName("");
    setAmount("");
    setCurrency("USD");
    setFrequency("one_time");
    setExpenseDate(new Date());
    setHasEndDate(false);
    setEndDate(undefined);
    setCategory("");
    setMarketplace("all");
    setDescription("");
    setIsAdvertisingCost(false);
  };

  const allCategories = [...IRS_CATEGORIES, ...customCategories.map(c => c.name)];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <DollarSign className="h-4 w-4 mr-2" />
          Add New Expense
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New Expense</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Expense Name */}
          <div className="space-y-2">
            <Label>Expense Name</Label>
            <Input
              type="text"
              placeholder="e.g., Helium10 Subscription, Software Costs..."
              value={expenseName}
              onChange={(e) => setExpenseName(e.target.value)}
            />
          </div>

          {/* Category — moved right under Expense Name */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Category (Other Expenses)</Label>
              <span className="text-[10px] text-muted-foreground">
                Tax-grade — rolls up under "Other Expenses" in P&L
              </span>
            </div>
            <div className="flex gap-2">
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger className="flex-1">
                  <SelectValue placeholder="Select a category" />
                </SelectTrigger>
                <SelectContent className="max-h-60">
                  {IRS_CATEGORIES.map((cat) => (
                    <SelectItem key={cat} value={cat}>
                      {cat}
                    </SelectItem>
                  ))}
                  {customCategories.length > 0 && (
                    <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground border-t mt-1 pt-2">
                      Custom Categories
                    </div>
                  )}
                  {customCategories.map((cat) => (
                    <SelectItem key={cat.id} value={cat.name}>
                      {cat.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setShowAddCategory(!showAddCategory)}
                title="Add custom category"
              >
                <Plus className="h-4 w-4 mr-1" /> New
              </Button>
            </div>

            {customCategories.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {customCategories.map((cat) => (
                  <span
                    key={cat.id}
                    className="inline-flex items-center gap-1 rounded-md border bg-muted/40 px-2 py-0.5 text-[11px]"
                  >
                    {cat.name}
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => handleDeleteCategory(cat.id, cat.name)}
                      title="Delete category"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}

            {category === "Damage / Loss" && (
              <div className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">
                <strong className="block mb-1">Use this only for non-Amazon losses</strong>
                Amazon-related losses (removals, disposals, liquidations, MFN returns, restricted inventory you can't resell on Amazon) are tracked automatically under <span className="font-semibold">Inventory Disposition Loss</span> in Disposition Management. Logging them here too will double-count your loss in the P&amp;L.
              </div>
            )}

            {showAddCategory && (
              <div className="flex gap-2 mt-2">
                <Input
                  placeholder="New category name"
                  value={newCategoryName}
                  onChange={(e) => setNewCategoryName(e.target.value)}
                />
                <Button onClick={handleAddCategory} size="sm">
                  Add
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setNewCategoryName("");
                    setShowAddCategory(false);
                  }}
                >
                  Cancel
                </Button>
              </div>
            )}
          </div>


          {/* Currency — auto-detected from the seller's home marketplace */}
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Currency</Label>
            <div
              className="inline-flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-1.5 text-sm"
              title="Currency is set by your home marketplace"
            >
              <span className="font-semibold">{homeCurrencySymbol}</span>
              <span className="text-muted-foreground">{homeCurrency}</span>
              <span className="ml-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                Auto
              </span>
            </div>
          </div>


          {/* Amount */}
          <div className="space-y-2">
            <Label>Amount</Label>
            <Input
              type="number"
              step="0.01"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>

          {/* Frequency */}
          <div className="space-y-2">
            <Label>Frequency</Label>
            <div className="flex flex-wrap gap-1">
              {FREQUENCIES.map((f) => (
                <Button
                  key={f.value}
                  variant={frequency === f.value ? "default" : "outline"}
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setFrequency(f.value)}
                >
                  {f.label}
                </Button>
              ))}
            </div>
          </div>

          {/* Start Date */}
          <div className="space-y-2">
            <Label>Start Date</Label>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className={cn(
                    "w-full justify-start text-left font-normal",
                    !expenseDate && "text-muted-foreground"
                  )}
                >
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {expenseDate ? format(expenseDate, "MMMM d, yyyy") : "Pick a date"}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={expenseDate}
                  onSelect={(date) => date && setExpenseDate(date)}
                  initialFocus
                  className="p-3 pointer-events-auto"
                />
              </PopoverContent>
            </Popover>
          </div>

          {/* End Date Option */}
          <div className="space-y-2">
            <div className="flex items-center space-x-2">
              <Checkbox
                id="hasEndDate"
                checked={hasEndDate}
                onCheckedChange={(checked) => {
                  setHasEndDate(checked === true);
                  if (!checked) setEndDate(undefined);
                }}
              />
              <Label htmlFor="hasEndDate" className="text-sm">
                This expense has an end date
              </Label>
            </div>
            
            {hasEndDate && (
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className={cn(
                      "w-full justify-start text-left font-normal",
                      !endDate && "text-muted-foreground"
                    )}
                  >
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {endDate ? format(endDate, "MMMM d, yyyy") : "Pick end date"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={endDate}
                    onSelect={(date) => date && setEndDate(date)}
                    initialFocus
                    className="p-3 pointer-events-auto"
                    disabled={(date) => date < expenseDate}
                  />
                </PopoverContent>
              </Popover>
            )}
          </div>

          {/* Advertising cost checkbox, Marketplace dropdown, and Description
              are intentionally hidden per product requirements. Their state
              still defaults to safe values (all / empty / false) on submit. */}


          {/* Submit button */}
          <Button onClick={handleSubmit} disabled={loading} className="w-full">
            {loading ? "Adding..." : "Add Expense"}
          </Button>
        </div>

        {/* Recent Expenses list hidden — the full list lives on the Expenses page */}

      </DialogContent>
    </Dialog>
  );
}
