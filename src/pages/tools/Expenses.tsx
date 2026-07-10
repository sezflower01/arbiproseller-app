import { useState, useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Trash2, Search, Calendar, Repeat, Pencil, Check, X, Lock as LockIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import { format, addMonths, startOfMonth, endOfMonth, isBefore, isAfter } from "date-fns";
import { ExpenseDialog } from "@/components/sales/ExpenseDialog";

interface Expense {
  id: string;
  name: string | null;
  amount: number;
  currency: string;
  category: string;
  frequency: string;
  expense_date: string;
  end_date: string | null;
  marketplace: string | null;
  description: string | null;
  is_advertising_cost: boolean | null;
  created_at: string;
  skipped_months?: string[] | null;
  amount_overrides?: Record<string, number> | null;
}

// Expanded expense row for display (includes generated monthly occurrences)
interface ExpandedExpense extends Expense {
  displayDate: string; // The specific month this occurrence applies to
  isRecurring: boolean;
  originalId: string; // Reference to the original expense for deletion
  monthKey?: string; // YYYY-MM key for recurring occurrences (used to skip a single month)
  isFirstOccurrence: boolean; // Only the first row of a sequence may have its Type changed
}

const FREQUENCY_LABELS: Record<string, string> = {
  one_time: "One-Time",
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
  quarterly: "Quarterly",
  half_yearly: "Half-Yearly",
  annually: "Annually",
};

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  CAD: "C$",
  EUR: "€",
  GBP: "£",
  INR: "₹",
  JPY: "¥",
  CHF: "₣",
  HKD: "HK$",
  SEK: "kr",
  NOK: "kr",
  RUB: "₽",
  AED: "د.",
  PLN: "zł",
  BRL: "R$",
  MXN: "MX$",
  AUD: "A$",
};

// Parse a YYYY-MM-DD date string as a LOCAL date (avoids UTC shifting it
// into the previous day in negative timezones, which would otherwise generate
// a phantom month at the start of every recurring expense).
function parseLocalDate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

// Expand recurring expenses into individual monthly rows
function expandRecurringExpenses(expenses: Expense[]): ExpandedExpense[] {
  const expanded: ExpandedExpense[] = [];
  const now = new Date();
  const currentMonthEnd = endOfMonth(now);
  
  for (const expense of expenses) {
    if (expense.frequency === "one_time") {
      // One-time expenses: show as single row
      expanded.push({
        ...expense,
        displayDate: expense.expense_date,
        isRecurring: false,
        originalId: expense.id,
        isFirstOccurrence: true,
      });
    } else if (expense.frequency === "monthly") {
      // Monthly expenses: generate a row for each month from start to end (or current month)
      const startDate = startOfMonth(parseLocalDate(expense.expense_date));
      const endDate = expense.end_date 
        ? endOfMonth(parseLocalDate(expense.end_date))
        : currentMonthEnd;
      const skipped = new Set((expense.skipped_months ?? []).map((s) => s.slice(0, 7)));
      const overrides = expense.amount_overrides ?? {};

      let currentDate = startDate;
      let monthIndex = 0;
      let firstPushed = false;

      while (!isAfter(currentDate, endDate) && !isAfter(currentDate, currentMonthEnd)) {
        const monthKey = format(currentDate, "yyyy-MM");
        if (!skipped.has(monthKey)) {
          const overrideAmt = overrides[monthKey];
          // A single-record edit is an explicit override for that month only.
          // It must not flow into the latest/generated occurrence.
          const effectiveAmt = typeof overrideAmt === "number" ? overrideAmt : expense.amount;
          expanded.push({
            ...expense,
            id: `${expense.id}-month-${monthIndex}`,
            amount: effectiveAmt,
            displayDate: format(currentDate, "yyyy-MM-dd"),
            isRecurring: true,
            originalId: expense.id,
            monthKey,
            isFirstOccurrence: !firstPushed,
          });
          firstPushed = true;
        }
        currentDate = addMonths(currentDate, 1);
        monthIndex++;
        
        // Safety limit to prevent infinite loops
        if (monthIndex > 120) break; // Max 10 years
      }
    } else {
      // Other frequencies (daily, weekly, etc.): show as single row for now
      expanded.push({
        ...expense,
        displayDate: expense.expense_date,
        isRecurring: expense.frequency !== "one_time",
        originalId: expense.id,
        isFirstOccurrence: true,
      });
    }
  }
  
  // Sort by display date descending
  expanded.sort((a, b) => new Date(b.displayDate).getTime() - new Date(a.displayDate).getTime());
  
  return expanded;
}

export default function Expenses() {
  const { user } = useAuth();
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [monthFilter, setMonthFilter] = useState("all");
  const [frequencyFilter, setFrequencyFilter] = useState("all");
  // Inline-edit state for the active Amount cell. Recurring rows use the row
  // key so editing one occurrence doesn't open/update every generated month.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingRowKey, setEditingRowKey] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState<string>("");
  // Scope of the active amount edit — 'series' updates the base amount for
  // every month, 'single' writes a per-month override in amount_overrides.
  const [editingScope, setEditingScope] = useState<"single" | "series">("series");
  const [editingMonthKey, setEditingMonthKey] = useState<string | null>(null);
  // Popup that asks whether an Amount edit should apply to one record or the
  // whole series. Non-recurring rows skip this and edit inline immediately.
  const [pendingAmountEdit, setPendingAmountEdit] = useState<
    { originalId: string; monthKey: string; current: number; displayDate: string; name: string | null } | null
  >(null);
  // Inline-edit state for the Name cell.
  const [editingNameId, setEditingNameId] = useState<string | null>(null);
  const [editingNameValue, setEditingNameValue] = useState<string>("");
  // Confirm dialog for recurring type change
  const [pendingFreq, setPendingFreq] = useState<{ id: string; next: string; startDate: string } | null>(null);
  // Confirm dialog for ending a recurring series
  const [pendingEnd, setPendingEnd] = useState<
    { originalId: string; monthKey: string; displayDate: string; name: string | null } | null
  >(null);

  const handleEndSeries = async (
    originalId: string,
    monthKey: string | null | undefined,
    displayDate: string,
  ) => {
    // End the series so this record + all following occurrences disappear.
    // For monthly series we end at the last day of the previous month.
    // For other frequencies (annual, quarterly, etc.) we end one day before
    // the selected occurrence so that occurrence and all future ones are hidden.
    let endDateStr: string;
    if (monthKey) {
      const [y, m] = monthKey.split("-").map(Number);
      const prevMonth = new Date(y, (m || 1) - 2, 1);
      endDateStr = format(endOfMonth(prevMonth), "yyyy-MM-dd");
    } else {
      const d = parseLocalDate(displayDate);
      d.setDate(d.getDate() - 1);
      endDateStr = format(d, "yyyy-MM-dd");
    }

    const { error } = await supabase
      .from("expenses")
      .update({ end_date: endDateStr })
      .eq("id", originalId)
      .eq("user_id", user?.id);

    if (error) {
      toast.error("Failed to end series");
      console.error(error);
      return;
    }
    setExpenses((prev) =>
      prev.map((e) => (e.id === originalId ? { ...e, end_date: endDateStr } : e)),
    );
    toast.success("Series ended");
    setPendingEnd(null);
  };

  const getAmountEditKey = (originalId: string, monthKey?: string | null) =>
    monthKey ? `${originalId}:${monthKey}` : originalId;

  const isAmountEditorOpenForRow = (expense: ExpandedExpense) => {
    if (editingId !== expense.originalId) return false;
    if (editingScope === "series") return true;
    return editingRowKey === getAmountEditKey(expense.originalId, expense.monthKey);
  };

  const startEditAmount = (
    originalId: string,
    current: number,
    scope: "single" | "series" = "series",
    monthKey: string | null = null,
    rowMonthKey: string | null = monthKey,
  ) => {
    setEditingId(originalId);
    setEditingRowKey(getAmountEditKey(originalId, rowMonthKey));
    setEditingValue(String(current));
    setEditingScope(scope);
    setEditingMonthKey(scope === "single" ? monthKey : null);
  };

  const cancelEditAmount = () => {
    setEditingId(null);
    setEditingRowKey(null);
    setEditingValue("");
    setEditingScope("series");
    setEditingMonthKey(null);
  };

  const saveEditAmount = async (originalId: string) => {
    const next = Number.parseFloat(editingValue);
    if (!Number.isFinite(next) || next < 0) {
      toast.error("Enter a valid amount");
      return;
    }
    const original = expenses.find((e) => e.id === originalId);
    if (!original) return;

    if (editingScope === "single" && editingMonthKey) {
      const currentOverrides = { ...(original.amount_overrides ?? {}) };
      if (currentOverrides[editingMonthKey] === next) {
        cancelEditAmount();
        return;
      }
      currentOverrides[editingMonthKey] = next;
      const { error } = await supabase
        .from("expenses")
        .update({ amount_overrides: currentOverrides })
        .eq("id", originalId)
        .eq("user_id", user?.id);
      if (error) {
        toast.error("Failed to update this occurrence");
        console.error(error);
        return;
      }
      setExpenses(
        expenses.map((e) =>
          e.id === originalId ? { ...e, amount_overrides: currentOverrides } : e,
        ),
      );
      toast.success("This occurrence updated");
      cancelEditAmount();
      return;
    }

    if (Number(original.amount) === next) {
      cancelEditAmount();
      return;
    }
    const { error } = await supabase
      .from("expenses")
      .update({ amount: next })
      .eq("id", originalId)
      .eq("user_id", user?.id);
    if (error) {
      toast.error("Failed to update amount");
      console.error(error);
      return;
    }
    setExpenses(expenses.map((e) => (e.id === originalId ? { ...e, amount: next } : e)));
    toast.success("Entire series updated");
    cancelEditAmount();
  };


  const startEditName = (originalId: string, current: string | null) => {
    setEditingNameId(originalId);
    setEditingNameValue(current ?? "");
  };

  const cancelEditName = () => {
    setEditingNameId(null);
    setEditingNameValue("");
  };

  const saveEditName = async (originalId: string) => {
    const next = editingNameValue.trim();
    const original = expenses.find((e) => e.id === originalId);
    if (!original) return;
    if ((original.name ?? "") === next) {
      cancelEditName();
      return;
    }
    const { error } = await supabase
      .from("expenses")
      .update({ name: next || null })
      .eq("id", originalId)
      .eq("user_id", user?.id);
    if (error) {
      toast.error("Failed to update name");
      console.error(error);
      return;
    }
    setExpenses(expenses.map((e) => (e.id === originalId ? { ...e, name: next || null } : e)));
    toast.success("Name updated");
    cancelEditName();
  };

  const updateFrequency = async (originalId: string, next: string) => {
    const original = expenses.find((e) => e.id === originalId);
    if (!original || original.frequency === next) return;
    const recurring = ["weekly", "monthly", "quarterly", "half_yearly", "annually"];
    if (recurring.includes(next)) {
      setPendingFreq({ id: originalId, next, startDate: original.expense_date });
      return;
    }
    await commitFrequency(originalId, next);
  };

  const commitFrequency = async (originalId: string, next: string) => {
    const { error } = await supabase
      .from("expenses")
      .update({ frequency: next })
      .eq("id", originalId)
      .eq("user_id", user?.id);
    if (error) {
      toast.error("Failed to update type");
      console.error(error);
      return;
    }
    setExpenses((prev) => prev.map((e) => (e.id === originalId ? { ...e, frequency: next } : e)));
    toast.success("Type updated");
  };

  const fetchExpenses = async () => {
    if (!user) return;
    setLoading(true);
    
    const { data, error } = await supabase
      .from("expenses")
      .select("*")
      .eq("user_id", user.id)
      .order("expense_date", { ascending: false });

    if (error) {
      toast.error("Failed to load expenses");
      console.error(error);
    } else {
      setExpenses((data || []) as Expense[]);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchExpenses();
  }, [user]);

  // Expand recurring expenses into individual rows
  const expandedExpenses = useMemo(() => expandRecurringExpenses(expenses), [expenses]);

  const handleDelete = async (originalId: string) => {
    const { error } = await supabase
      .from("expenses")
      .delete()
      .eq("id", originalId)
      .eq("user_id", user?.id);

    if (error) {
      toast.error("Failed to delete expense");
    } else {
      setExpenses(expenses.filter((e) => e.id !== originalId));
      toast.success("Expense deleted (all occurrences removed)");
    }
  };

  // Hide just one month of a recurring expense by appending its YYYY-MM key
  // to skipped_months. The original recurring row stays intact.
  const handleSkipMonth = async (originalId: string, monthKey: string) => {
    const original = expenses.find((e) => e.id === originalId);
    if (!original) return;
    const current = original.skipped_months ?? [];
    if (current.includes(monthKey)) {
      toast.info("That month is already removed");
      return;
    }
    const next = [...current, monthKey];
    const { error } = await supabase
      .from("expenses")
      .update({ skipped_months: next })
      .eq("id", originalId)
      .eq("user_id", user?.id);

    if (error) {
      toast.error("Failed to remove that month");
      console.error(error);
    } else {
      setExpenses(expenses.map((e) => (e.id === originalId ? { ...e, skipped_months: next } : e)));
      toast.success("Month removed");
    }
  };

  // Get unique categories for filter
  const categories = [...new Set(expenses.map((e) => e.category))];

  // Filter expanded expenses
  const filteredExpenses = expandedExpenses.filter((expense) => {
    const term = searchTerm.trim().toLowerCase();
    const numericTerm = term.replace(/[^0-9.]/g, "");
    const amountNum = Number(expense.amount || 0);
    // Exact amount match only (e.g. "500" matches 500.00, "500.5" matches 500.50).
    const amountMatches =
      numericTerm !== "" &&
      !Number.isNaN(Number(numericTerm)) &&
      Number(numericTerm) === Number(amountNum.toFixed(2));
    const matchesSearch =
      !term ||
      expense.name?.toLowerCase().includes(term) ||
      expense.category.toLowerCase().includes(term) ||
      amountMatches;

    const matchesCategory =
      categoryFilter === "all" || expense.category === categoryFilter;

    const matchesFrequency =
      frequencyFilter === "all" || expense.frequency === frequencyFilter;

    const matchesMonth =
      monthFilter === "all" ||
      (expense.displayDate && expense.displayDate.split("-")[1] === monthFilter);

    return matchesSearch && matchesCategory && matchesFrequency && matchesMonth;
  });

  const formatCurrency = (amount: number, currency: string) => {
    const symbol = CURRENCY_SYMBOLS[currency] || currency;
    return `${symbol}${amount.toFixed(2)}`;
  };

  const formatDisplayDate = (displayDate: string, isRecurring: boolean) => {
    // Parse as local date to avoid UTC offset shifting Jan 1 → Dec 31 in PT.
    const [y, m, d] = displayDate.split("-").map(Number);
    const date = new Date(y, (m || 1) - 1, d || 1);
    if (isRecurring) {
      // For recurring, show the actual billing day + month/year
      return format(date, "MMM d, yyyy");
    }
    return format(date, "MMM d, yyyy");
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto px-4 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-4">
            <Link to="/tools">
              <Button variant="ghost" size="icon">
                <ArrowLeft className="h-5 w-5" />
              </Button>
            </Link>
            <div>
              <h1 className="text-2xl font-bold text-foreground">My Expenses</h1>
              <p className="text-muted-foreground">
                View and manage all your business expenses
              </p>
            </div>
          </div>
          <ExpenseDialog onExpenseAdded={fetchExpenses} />
        </div>

        {/* Filters */}
        <div className="flex flex-wrap gap-4 mb-6">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by name, category, or amount..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10"
            />
          </div>
          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="All Categories" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Categories</SelectItem>
              {categories.map((cat) => (
                <SelectItem key={cat} value={cat}>
                  {cat}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={monthFilter} onValueChange={setMonthFilter}>
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder="All Months" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Months</SelectItem>
              {[
                ["01", "Jan"], ["02", "Feb"], ["03", "Mar"], ["04", "Apr"],
                ["05", "May"], ["06", "Jun"], ["07", "Jul"], ["08", "Aug"],
                ["09", "Sep"], ["10", "Oct"], ["11", "Nov"], ["12", "Dec"],
              ].map(([v, l]) => (
                <SelectItem key={v} value={v}>{l}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={frequencyFilter} onValueChange={setFrequencyFilter}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="All Frequencies" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Frequencies</SelectItem>
              <SelectItem value="one_time">One-Time</SelectItem>
              <SelectItem value="daily">Daily</SelectItem>
              <SelectItem value="weekly">Weekly</SelectItem>
              <SelectItem value="monthly">Monthly</SelectItem>
              <SelectItem value="quarterly">Quarterly</SelectItem>
              <SelectItem value="half_yearly">Half-Yearly</SelectItem>
              <SelectItem value="annually">Annually</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Summary */}
        <div className="bg-card rounded-lg border p-4 mb-6">
          <div className="flex flex-wrap gap-6">
            <div>
              <p className="text-sm text-muted-foreground">Total Expenses</p>
              <p className="text-2xl font-bold">{filteredExpenses.length}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Total Amount (USD)</p>
              <p className="text-2xl font-bold text-destructive">
                ${filteredExpenses
                  .filter((e) => e.currency === "USD")
                  .reduce((sum, e) => sum + e.amount, 0)
                  .toFixed(2)}
              </p>
            </div>
          </div>
        </div>

        {/* Table */}
        <div className="bg-card rounded-lg border overflow-hidden">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Period</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="hidden">Marketplace</TableHead>
                  <TableHead className="hidden">Advertising</TableHead>
                  <TableHead>Ending</TableHead>
                  <TableHead className="w-[60px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={9} className="text-center py-8">
                      <div className="flex items-center justify-center">
                        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary"></div>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : filteredExpenses.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={9}
                      className="text-center py-8 text-muted-foreground"
                    >
                      No expenses found
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredExpenses.map((expense) => (
                    <TableRow key={expense.id}>
                      <TableCell className="whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          {expense.isRecurring ? (
                            <Repeat className="h-4 w-4 text-blue-500" />
                          ) : (
                            <Calendar className="h-4 w-4 text-muted-foreground" />
                          )}
                          <span className="text-sm">
                            {formatDisplayDate(expense.displayDate, expense.isRecurring)}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="font-medium">
                        {editingNameId === expense.originalId ? (
                          <div className="flex items-center gap-1">
                            <Input
                              autoFocus
                              value={editingNameValue}
                              onChange={(e) => setEditingNameValue(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") saveEditName(expense.originalId);
                                if (e.key === "Escape") cancelEditName();
                              }}
                              className="h-8 w-48 text-sm"
                            />
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-green-600"
                              onClick={() => saveEditName(expense.originalId)}
                              title="Save"
                            >
                              <Check className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-muted-foreground"
                              onClick={cancelEditName}
                              title="Cancel"
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => startEditName(expense.originalId, expense.name)}
                            title={
                              expense.isRecurring
                                ? "Edit name (applies to every month of this recurring expense)"
                                : "Edit name"
                            }
                            className="group inline-flex items-center gap-1 hover:text-primary transition-colors text-left"
                          >
                            <span>{expense.name || "-"}</span>
                            <Pencil className="h-3 w-3 opacity-0 group-hover:opacity-60" />
                          </button>
                        )}
                      </TableCell>
                      <TableCell className="font-mono">
                        {isAmountEditorOpenForRow(expense) ? (
                          <div className="flex items-center gap-1">
                            <span className="text-xs text-muted-foreground">
                              {CURRENCY_SYMBOLS[expense.currency] || expense.currency}
                            </span>
                            <Input
                              type="number"
                              step="0.01"
                              min="0"
                              autoFocus
                              value={editingValue}
                              onChange={(e) => setEditingValue(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") saveEditAmount(expense.originalId);
                                if (e.key === "Escape") cancelEditAmount();
                              }}
                              className="h-8 w-24 font-mono text-sm"
                            />
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-green-600"
                              onClick={() => saveEditAmount(expense.originalId)}
                              title="Save"
                            >
                              <Check className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-muted-foreground"
                              onClick={cancelEditAmount}
                              title="Cancel"
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              if (expense.isRecurring && expense.monthKey) {
                                setPendingAmountEdit({
                                  originalId: expense.originalId,
                                  monthKey: expense.monthKey,
                                  current: expense.amount,
                                  displayDate: expense.displayDate,
                                  name: expense.name,
                                });
                              } else {
                                startEditAmount(expense.originalId, expense.amount, "series", null, null);
                              }
                            }}
                            title={
                              expense.isRecurring
                                ? "Edit amount — choose this record only or the entire series"
                                : "Edit amount"
                            }
                            className="group inline-flex items-center gap-1 hover:text-primary transition-colors"
                          >
                            <span>{formatCurrency(expense.amount, expense.currency)}</span>
                            <Pencil className="h-3 w-3 opacity-0 group-hover:opacity-60" />
                          </button>

                        )}
                      </TableCell>
                      <TableCell>
                        <span className="inline-flex items-center px-2 py-1 rounded-full text-xs bg-secondary text-secondary-foreground">
                          {expense.category}
                        </span>
                      </TableCell>
                      <TableCell>
                        {expense.isFirstOccurrence ? (
                          <Select
                            value={expense.frequency}
                            onValueChange={(val) => updateFrequency(expense.originalId, val)}
                          >
                            <SelectTrigger className={`h-8 w-[140px] ${expense.isRecurring ? "text-blue-500" : ""}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {Object.entries(FREQUENCY_LABELS).map(([val, label]) => (
                                <SelectItem key={val} value={val}>{label}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <span
                            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground"
                            title="Locked — only the first occurrence of a recurring sequence can change type"
                          >
                            <LockIcon className="h-3 w-3" />
                            {FREQUENCY_LABELS[expense.frequency] || expense.frequency}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="hidden">
                        {expense.marketplace || "All"}
                      </TableCell>
                      <TableCell className="hidden">
                        {expense.is_advertising_cost ? (
                          <span className="text-green-600">Yes</span>
                        ) : (
                          <span className="text-muted-foreground">No</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {expense.isRecurring ? (
                          expense.end_date ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                              Ended
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() =>
                                setPendingEnd({
                                  originalId: expense.originalId,
                                  monthKey: expense.monthKey ?? "",
                                  displayDate: expense.displayDate,
                                  name: expense.name,
                                })
                              }
                              title="End this series starting from this record"
                              className="inline-flex items-center gap-1 rounded-full bg-blue-500/10 px-2 py-0.5 text-xs font-medium text-blue-600 hover:bg-blue-500/20 dark:text-blue-400 transition-colors"
                            >
                              No End
                            </button>
                          )
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {expense.isFirstOccurrence ? (
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </AlertDialogTrigger>

                          <AlertDialogContent className="overflow-hidden border-0 p-0 shadow-2xl sm:max-w-2xl">
                            {/* Gradient header */}
                            <div className="relative bg-gradient-to-br from-rose-600 via-red-600 to-orange-500 px-6 py-6 text-white">
                              <div className="absolute inset-0 opacity-20 [background-image:radial-gradient(circle_at_20%_20%,white_0,transparent_40%),radial-gradient(circle_at_80%_60%,white_0,transparent_40%)]" />
                              <div className="relative flex items-center gap-3">
                                <div className="flex h-11 w-11 items-center justify-center rounded-full bg-white/15 ring-1 ring-white/30 backdrop-blur">
                                  <Trash2 className="h-5 w-5" />
                                </div>
                                <div>
                                  <AlertDialogHeader className="p-0">
                                    <AlertDialogTitle className="text-lg font-semibold text-white">
                                      {expense.isRecurring ? "Delete recurring expense?" : "Delete expense?"}
                                    </AlertDialogTitle>
                                  </AlertDialogHeader>
                                  <p className="mt-0.5 text-xs text-white/80">
                                    {expense.isRecurring ? "Choose what to remove" : "This cannot be undone"}
                                  </p>
                                </div>
                              </div>
                            </div>

                            {/* Body */}
                            <div className="space-y-4 px-6 py-5">
                              <AlertDialogDescription className="text-sm text-muted-foreground leading-relaxed">
                                {expense.isRecurring
                                  ? "Do you want to delete just this one record, or the whole recurring series?"
                                  : "Are you sure you want to delete this expense? This action cannot be undone."}
                              </AlertDialogDescription>

                              {expense.isRecurring && (
                                <div className="rounded-lg border bg-muted/40 p-3 space-y-2">
                                  <div className="flex items-center justify-between text-xs">
                                    <span className="text-muted-foreground">Name</span>
                                    <span className="font-medium text-foreground truncate max-w-[200px]">
                                      {expense.name || "—"}
                                    </span>
                                  </div>
                                  <div className="flex items-center justify-between text-xs">
                                    <span className="text-muted-foreground">This record</span>
                                    <span className="inline-flex items-center gap-1.5 font-mono text-foreground">
                                      <Calendar className="h-3 w-3 text-muted-foreground" />
                                      {formatDisplayDate(expense.displayDate, true)}
                                    </span>
                                  </div>
                                  <div className="flex items-center justify-between text-xs">
                                    <span className="text-muted-foreground">Frequency</span>
                                    <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-500/10 px-2.5 py-1 font-medium text-blue-600 dark:text-blue-400">
                                      <Repeat className="h-3 w-3" />
                                      {FREQUENCY_LABELS[expense.frequency] || expense.frequency}
                                    </span>
                                  </div>
                                </div>
                              )}

                              <AlertDialogFooter className="gap-2 sm:gap-2 flex-col sm:flex-row">
                                <AlertDialogCancel className="mt-0">Cancel</AlertDialogCancel>
                                {expense.isRecurring && expense.monthKey && (
                                  <AlertDialogAction
                                    onClick={() => handleSkipMonth(expense.originalId, expense.monthKey!)}
                                    className="bg-amber-500 text-white hover:bg-amber-600"
                                  >
                                    Delete this record only
                                  </AlertDialogAction>
                                )}
                                <AlertDialogAction
                                  onClick={() => handleDelete(expense.originalId)}
                                  className="bg-gradient-to-r from-rose-600 to-red-600 text-white hover:from-rose-700 hover:to-red-700"
                                >
                                  {expense.isRecurring ? "Delete record + entire series" : "Delete"}
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </div>
                          </AlertDialogContent>
                        </AlertDialog>
                        ) : (
                          <Button
                            variant="ghost"
                            size="icon"
                            disabled
                            className="h-8 w-8 text-muted-foreground/40 cursor-not-allowed"
                            title="Locked — only the first occurrence can be deleted"
                          >
                            <LockIcon className="h-4 w-4" />
                          </Button>
                        )}
                      </TableCell>

                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      </div>

      <AlertDialog open={!!pendingFreq} onOpenChange={(o) => !o && setPendingFreq(null)}>
        <AlertDialogContent className="overflow-hidden border-0 p-0 shadow-2xl sm:max-w-2xl">
          {/* Gradient header */}
          <div className="relative bg-gradient-to-br from-indigo-600 via-blue-600 to-cyan-500 px-6 py-6 text-white">
            <div className="absolute inset-0 opacity-20 [background-image:radial-gradient(circle_at_20%_20%,white_0,transparent_40%),radial-gradient(circle_at_80%_60%,white_0,transparent_40%)]" />
            <div className="relative flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-full bg-white/15 ring-1 ring-white/30 backdrop-blur">
                <Repeat className="h-5 w-5" />
              </div>
              <div>
                <AlertDialogHeader className="p-0">
                  <AlertDialogTitle className="text-lg font-semibold text-white">
                    Create recurring sequence?
                  </AlertDialogTitle>
                </AlertDialogHeader>
                <p className="mt-0.5 text-xs text-white/80">
                  This will generate ongoing entries
                </p>
              </div>
            </div>
          </div>

          {/* Body */}
          <div className="space-y-4 px-6 py-5">
            <p className="text-sm text-muted-foreground leading-relaxed">
              Switching type to{" "}
              <span className="font-semibold text-foreground">
                {pendingFreq ? FREQUENCY_LABELS[pendingFreq.next] : ""}
              </span>{" "}
              will create a repeating expense on this schedule.
            </p>

            <div className="rounded-lg border bg-muted/40 p-3">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">New frequency</span>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-500/10 px-2.5 py-1 font-medium text-blue-600 dark:text-blue-400">
                  <Repeat className="h-3 w-3" />
                  {pendingFreq ? FREQUENCY_LABELS[pendingFreq.next] : ""}
                </span>
              </div>
              <div className="mt-2 flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Starts on</span>
                <span className="inline-flex items-center gap-1.5 font-mono text-foreground">
                  <Calendar className="h-3 w-3 text-muted-foreground" />
                  {pendingFreq?.startDate}
                </span>
              </div>
            </div>

            <AlertDialogFooter className="gap-2 sm:gap-2">
              <AlertDialogCancel className="mt-0">No, cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-gradient-to-r from-indigo-600 to-blue-600 text-white hover:from-indigo-700 hover:to-blue-700"
                onClick={async () => {
                  if (pendingFreq) {
                    const p = pendingFreq;
                    setPendingFreq(null);
                    await commitFrequency(p.id, p.next);
                  }
                }}
              >
                Yes, create sequence
              </AlertDialogAction>
            </AlertDialogFooter>
          </div>
        </AlertDialogContent>
      </AlertDialog>

      {/* End recurring series confirmation */}
      <AlertDialog open={!!pendingEnd} onOpenChange={(o) => !o && setPendingEnd(null)}>
        <AlertDialogContent className="overflow-hidden border-0 p-0 shadow-2xl sm:max-w-lg">
          <div className="relative bg-gradient-to-br from-amber-600 via-orange-600 to-rose-500 px-6 py-6 text-white">
            <div className="absolute inset-0 opacity-20 [background-image:radial-gradient(circle_at_20%_20%,white_0,transparent_40%),radial-gradient(circle_at_80%_60%,white_0,transparent_40%)]" />
            <div className="relative flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-full bg-white/15 ring-1 ring-white/30 backdrop-blur">
                <X className="h-5 w-5" />
              </div>
              <div>
                <AlertDialogHeader className="p-0">
                  <AlertDialogTitle className="text-lg font-semibold text-white">
                    End this series?
                  </AlertDialogTitle>
                </AlertDialogHeader>
                <p className="mt-0.5 text-xs text-white/80">
                  This record and all following months will be removed
                </p>
              </div>
            </div>
          </div>
          <div className="space-y-4 px-6 py-5">
            <AlertDialogDescription className="text-sm text-muted-foreground leading-relaxed">
              Are you sure you want to end this series? This record and every future
              occurrence will be removed, and the series will be marked as{" "}
              <span className="font-semibold text-foreground">Ended</span>.
            </AlertDialogDescription>
            {pendingEnd && (
              <div className="rounded-lg border bg-muted/40 p-3 space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Name</span>
                  <span className="font-medium text-foreground truncate max-w-[220px]">
                    {pendingEnd.name || "—"}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Ending from</span>
                  <span className="inline-flex items-center gap-1.5 font-mono text-foreground">
                    <Calendar className="h-3 w-3 text-muted-foreground" />
                    {formatDisplayDate(pendingEnd.displayDate, true)}
                  </span>
                </div>
              </div>
            )}
            <AlertDialogFooter className="gap-2 sm:gap-2">
              <AlertDialogCancel className="mt-0">No, keep going</AlertDialogCancel>
              <AlertDialogAction
                className="bg-gradient-to-r from-amber-600 to-rose-600 text-white hover:from-amber-700 hover:to-rose-700"
                onClick={() => {
                  if (pendingEnd) handleEndSeries(pendingEnd.originalId, pendingEnd.monthKey, pendingEnd.displayDate);
                }}
              >
                Yes, end series
              </AlertDialogAction>
            </AlertDialogFooter>
          </div>
        </AlertDialogContent>
      </AlertDialog>

      {/* Amount edit scope popup — this record only vs entire series */}
      <AlertDialog
        open={!!pendingAmountEdit}
        onOpenChange={(o) => !o && setPendingAmountEdit(null)}
      >
        <AlertDialogContent className="overflow-hidden border-0 p-0 shadow-2xl sm:max-w-2xl">
          {/* Gradient header */}
          <div className="relative bg-gradient-to-br from-emerald-600 via-teal-600 to-cyan-500 px-6 py-6 text-white">
            <div className="absolute inset-0 opacity-20 [background-image:radial-gradient(circle_at_20%_20%,white_0,transparent_40%),radial-gradient(circle_at_80%_60%,white_0,transparent_40%)]" />
            <div className="relative flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-full bg-white/15 ring-1 ring-white/30 backdrop-blur">
                <Pencil className="h-5 w-5" />
              </div>
              <div>
                <AlertDialogHeader className="p-0">
                  <AlertDialogTitle className="text-lg font-semibold text-white">
                    Edit amount — which occurrences?
                  </AlertDialogTitle>
                </AlertDialogHeader>
                <p className="mt-0.5 text-xs text-white/80">
                  Choose the scope of this change
                </p>
              </div>
            </div>
          </div>

          {/* Body */}
          <div className="space-y-4 px-6 py-5">
            <p className="text-sm text-muted-foreground leading-relaxed">
              You're editing{" "}
              <span className="font-semibold text-foreground">
                {pendingAmountEdit?.name ?? "this recurring expense"}
              </span>
              . Would you like this new amount to apply to{" "}
              <span className="font-semibold text-foreground">this record only</span>{" "}
              or to the <span className="font-semibold text-foreground">entire series</span>?
            </p>

            <div className="rounded-lg border bg-muted/40 p-3">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Occurrence</span>
                <span className="inline-flex items-center gap-1.5 font-mono text-foreground">
                  <Calendar className="h-3 w-3 text-muted-foreground" />
                  {pendingAmountEdit?.displayDate}
                </span>
              </div>
              <div className="mt-2 flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Current amount</span>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 font-medium text-emerald-600 dark:text-emerald-400">
                  {pendingAmountEdit
                    ? pendingAmountEdit.current.toFixed(2)
                    : ""}
                </span>
              </div>
            </div>

            <div className="grid gap-2 rounded-lg border bg-background p-3 text-xs text-muted-foreground">
              <div className="flex items-start gap-2">
                <Calendar className="mt-0.5 h-3.5 w-3.5 text-emerald-500" />
                <span>
                  <strong className="text-foreground">This record only</strong> — overrides
                  just this month; every other occurrence keeps the current amount.
                </span>
              </div>
              <div className="flex items-start gap-2">
                <Repeat className="mt-0.5 h-3.5 w-3.5 text-teal-500" />
                <span>
                  <strong className="text-foreground">Entire series</strong> — updates the
                  base amount so every past and future month reflects the new value.
                </span>
              </div>
            </div>

            <AlertDialogFooter className="gap-2 sm:gap-2">
              <AlertDialogCancel className="mt-0">Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-gradient-to-r from-emerald-600 to-teal-600 text-white hover:from-emerald-700 hover:to-teal-700"
                onClick={() => {
                  if (pendingAmountEdit) {
                    const p = pendingAmountEdit;
                    setPendingAmountEdit(null);
                    startEditAmount(p.originalId, p.current, "single", p.monthKey, p.monthKey);
                  }
                }}
              >
                This record only
              </AlertDialogAction>
              <AlertDialogAction
                className="bg-gradient-to-r from-indigo-600 to-blue-600 text-white hover:from-indigo-700 hover:to-blue-700"
                onClick={() => {
                  if (pendingAmountEdit) {
                    const p = pendingAmountEdit;
                    setPendingAmountEdit(null);
                    startEditAmount(p.originalId, p.current, "series", null, p.monthKey);
                  }
                }}
              >
                Entire series
              </AlertDialogAction>
            </AlertDialogFooter>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </div>

  );
}