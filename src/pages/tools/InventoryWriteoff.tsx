import { useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { CalendarIcon, Plus, Trash2, Pencil } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type Writeoff = {
  id: string;
  writeoff_date: string;
  asin: string | null;
  sku: string | null;
  title: string | null;
  quantity: number;
  unit_cost: number;
  total_cost: number;
  reason: string;
  notes: string | null;
};

const REASONS = [
  { value: "restricted", label: "Restricted" },
  { value: "dead_stock", label: "Dead stock" },
  { value: "expired", label: "Expired" },
  { value: "damaged", label: "Damaged" },
  { value: "other", label: "Other" },
];

const fmt$ = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n || 0);

export default function InventoryWriteoff() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Writeoff[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Writeoff | null>(null);

  // form state
  const [date, setDate] = useState<Date>(new Date());
  const [asin, setAsin] = useState("");
  const [sku, setSku] = useState("");
  const [title, setTitle] = useState("");
  const [qty, setQty] = useState<string>("1");
  const [unitCost, setUnitCost] = useState<string>("0");
  const [reason, setReason] = useState("restricted");
  const [notes, setNotes] = useState("");

  const totalCost = useMemo(() => (Number(qty) || 0) * (Number(unitCost) || 0), [qty, unitCost]);

  const totals = useMemo(() => {
    let units = 0,
      cost = 0;
    rows.forEach((r) => {
      units += r.quantity || 0;
      cost += Number(r.total_cost) || 0;
    });
    return { units, cost, count: rows.length };
  }, [rows]);

  const load = async () => {
    if (!user) return;
    setLoading(true);
    const { data, error } = await supabase
      .from("inventory_writeoffs")
      .select("*")
      .order("writeoff_date", { ascending: false });
    if (error) toast.error(error.message);
    else setRows((data as Writeoff[]) || []);
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, [user?.id]);

  const resetForm = () => {
    setEditing(null);
    setDate(new Date());
    setAsin("");
    setSku("");
    setTitle("");
    setQty("1");
    setUnitCost("0");
    setReason("restricted");
    setNotes("");
  };

  const startEdit = (r: Writeoff) => {
    setEditing(r);
    setDate(new Date(r.writeoff_date));
    setAsin(r.asin || "");
    setSku(r.sku || "");
    setTitle(r.title || "");
    setQty(String(r.quantity));
    setUnitCost(String(r.unit_cost));
    setReason(r.reason);
    setNotes(r.notes || "");
    setOpen(true);
  };

  const save = async () => {
    if (!user) return;
    const q = Number(qty);
    const c = Number(unitCost);
    if (!q || q < 1) return toast.error("Quantity must be at least 1");
    if (c < 0) return toast.error("Unit cost cannot be negative");

    const payload = {
      user_id: user.id,
      writeoff_date: format(date, "yyyy-MM-dd"),
      asin: asin.trim() || null,
      sku: sku.trim() || null,
      title: title.trim() || null,
      quantity: q,
      unit_cost: c,
      total_cost: q * c,
      reason,
      notes: notes.trim() || null,
    };

    if (editing) {
      const { error } = await supabase
        .from("inventory_writeoffs")
        .update(payload)
        .eq("id", editing.id);
      if (error) return toast.error(error.message);
      toast.success("Write-off updated");
    } else {
      const { error } = await supabase.from("inventory_writeoffs").insert(payload);
      if (error) return toast.error(error.message);
      toast.success("Write-off recorded");
    }
    setOpen(false);
    resetForm();
    load();
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this write-off?")) return;
    const { error } = await supabase.from("inventory_writeoffs").delete().eq("id", id);
    if (error) return toast.error(error.message);
    toast.success("Deleted");
    load();
  };

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">Inventory Write-Off (Warehouse)</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Track losses for items in your warehouse that became restricted, expired, damaged, or
            dead stock — separate from Amazon FBA dispositions. Date should be the day you confirm
            the item is unsellable.
          </p>
        </div>
        <Dialog
          open={open}
          onOpenChange={(v) => {
            setOpen(v);
            if (!v) resetForm();
          }}
        >
          <DialogTrigger asChild>
            <Button className="bg-[#0f1c3f] hover:bg-[#0f1c3f]/90">
              <Plus className="w-4 h-4 mr-2" />
              Add Write-Off
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>{editing ? "Edit Write-Off" : "Add Write-Off"}</DialogTitle>
            </DialogHeader>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <Label>Date *</Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className={cn("w-full justify-start font-normal mt-1", !date && "text-muted-foreground")}
                    >
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {date ? format(date, "PPP") : "Pick a date"}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={date}
                      onSelect={(d) => d && setDate(d)}
                      initialFocus
                      className={cn("p-3 pointer-events-auto")}
                    />
                  </PopoverContent>
                </Popover>
              </div>
              <div>
                <Label>ASIN</Label>
                <Input value={asin} onChange={(e) => setAsin(e.target.value)} placeholder="B0..." />
              </div>
              <div>
                <Label>SKU</Label>
                <Input value={sku} onChange={(e) => setSku(e.target.value)} placeholder="optional" />
              </div>
              <div className="col-span-2">
                <Label>Title</Label>
                <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Product title" />
              </div>
              <div>
                <Label>Quantity *</Label>
                <Input type="number" min={1} value={qty} onChange={(e) => setQty(e.target.value)} />
              </div>
              <div>
                <Label>Unit Cost *</Label>
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={unitCost}
                  onChange={(e) => setUnitCost(e.target.value)}
                />
              </div>
              <div>
                <Label>Total Cost</Label>
                <Input value={fmt$(totalCost)} readOnly className="bg-muted" />
              </div>
              <div>
                <Label>Reason *</Label>
                <Select value={reason} onValueChange={setReason}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {REASONS.map((r) => (
                      <SelectItem key={r.value} value={r.value}>
                        {r.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="col-span-2">
                <Label>Notes</Label>
                <Textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="optional"
                  rows={2}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button onClick={save} className="bg-[#0f1c3f] hover:bg-[#0f1c3f]/90">
                {editing ? "Update" : "Save"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Records</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totals.count}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Total Units Written Off</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totals.units.toLocaleString()}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Total Write-Off Loss</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600">{fmt$(totals.cost)}</div>
            <p className="text-xs text-muted-foreground mt-1">Flows into P&L as Business Loss</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>ASIN / SKU</TableHead>
                <TableHead>Title</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Unit Cost</TableHead>
                <TableHead className="text-right">Total Loss</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead className="w-24"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                    Loading…
                  </TableCell>
                </TableRow>
              )}
              {!loading && rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                    No write-offs yet. Click "Add Write-Off" to record your first one.
                  </TableCell>
                </TableRow>
              )}
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{format(new Date(r.writeoff_date), "yyyy-MM-dd")}</TableCell>
                  <TableCell className="font-mono text-xs">
                    <div>{r.asin || "—"}</div>
                    <div className="text-muted-foreground">{r.sku || ""}</div>
                  </TableCell>
                  <TableCell className="max-w-xs truncate">{r.title || "—"}</TableCell>
                  <TableCell className="text-right">{r.quantity}</TableCell>
                  <TableCell className="text-right">{fmt$(Number(r.unit_cost))}</TableCell>
                  <TableCell className="text-right font-semibold text-red-600">
                    {fmt$(Number(r.total_cost))}
                  </TableCell>
                  <TableCell>
                    {REASONS.find((x) => x.value === r.reason)?.label || r.reason}
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button size="icon" variant="ghost" onClick={() => startEdit(r)}>
                        <Pencil className="w-4 h-4" />
                      </Button>
                      <Button size="icon" variant="ghost" onClick={() => remove(r.id)}>
                        <Trash2 className="w-4 h-4 text-red-500" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
