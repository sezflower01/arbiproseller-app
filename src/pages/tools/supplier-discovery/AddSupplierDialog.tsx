import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Loader2, Plus, Pencil, Trash2 } from "lucide-react";
import CreateCategoryDialog from "./CreateCategoryDialog";

type Mode = "add" | "edit";

interface AddSupplierDialogProps {
  /** Called after add or edit. For edits, oldDomain is provided so the parent can re-select the renamed row. */
  onAdded: (newDomain: string, oldDomain?: string) => void;
  /** When set, dialog opens in edit mode for this supplier. */
  editTarget?: { id: string; display_name: string; domain: string } | null;
  /** Custom trigger label (default: "Add supplier" / "Edit"). */
  mode?: Mode;
}

function normalizeDomain(raw: string): string {
  let v = raw.trim().toLowerCase();
  v = v.replace(/^https?:\/\//, "");
  v = v.replace(/^www\./, "");
  v = v.replace(/\/.*$/, "");
  return v;
}

/**
 * Admin-only dialog to add OR edit a supplier in the Store Scan dropdown.
 * Format matches existing rows: display_name "Target", domain "target.com".
 */
export default function AddSupplierDialog({ onAdded, editTarget, mode = "add" }: AddSupplierDialogProps) {
  const isEdit = mode === "edit" && !!editTarget;

  const [open, setOpen] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [domain, setDomain] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // After a successful add/edit, prompt admin to create the first scan category
  // so the supplier becomes visible in the user-facing Store Scan immediately.
  const [createCatOpen, setCreateCatOpen] = useState(false);
  const [createCatFor, setCreateCatFor] = useState<{ domain: string; displayName: string } | null>(null);

  // Hydrate fields when opening in edit mode
  useEffect(() => {
    if (open && isEdit && editTarget) {
      setDisplayName(editTarget.display_name ?? "");
      setDomain(editTarget.domain ?? "");
    }
  }, [open, isEdit, editTarget]);

  const reset = () => {
    setDisplayName("");
    setDomain("");
  };

  const handleSubmit = async () => {
    const name = displayName.trim();
    const dom = normalizeDomain(domain);

    if (!name) {
      toast.error("Display name is required (e.g. Target)");
      return;
    }
    if (!dom || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(dom)) {
      toast.error("Enter a valid domain (e.g. target.com)");
      return;
    }

    setSubmitting(true);
    try {
      // Duplicate check — exclude the row being edited
      const dupQuery = supabase
        .from("supplier_scan_profiles")
        .select("id, display_name")
        .eq("domain", dom);

      const { data: existing } = isEdit && editTarget
        ? await dupQuery.neq("id", editTarget.id).maybeSingle()
        : await dupQuery.maybeSingle();

      if (existing) {
        toast.error(`Supplier already exists: ${existing.display_name} — ${dom}`);
        setSubmitting(false);
        return;
      }

      if (isEdit && editTarget) {
        const { error } = await supabase
          .from("supplier_scan_profiles")
          .update({ display_name: name, domain: dom })
          .eq("id", editTarget.id);
        if (error) throw error;
        toast.success(`Updated ${name} — ${dom}`);
        onAdded(dom, editTarget.domain);
      } else {
        const { error } = await supabase
          .from("supplier_scan_profiles")
          .insert({
            domain: dom,
            display_name: name,
            is_enabled: true,
            pagination_type: "query_param",
            pagination_param: "page",
            max_pages_per_run: 5,
            max_products_per_run: 100,
          });
        if (error) throw error;
        toast.success(`Added ${name} — ${dom}`);
        onAdded(dom);
      }

      // Capture supplier info for the follow-up "create category" prompt.
      // We only auto-prompt on add — edits usually mean a category already exists.
      const justAdded = !isEdit;
      reset();
      setOpen(false);
      if (justAdded) {
        setCreateCatFor({ domain: dom, displayName: name });
        setCreateCatOpen(true);
      }
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to save supplier");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!isEdit || !editTarget) return;
    setDeleting(true);
    try {
      const { error } = await supabase
        .from("supplier_scan_profiles")
        .delete()
        .eq("id", editTarget.id);
      if (error) throw error;
      toast.success(`Removed ${editTarget.display_name}`);
      onAdded("", editTarget.domain); // signal parent to refresh + clear selection
      setConfirmDeleteOpen(false);
      setOpen(false);
      reset();
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to delete supplier");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
        <DialogTrigger asChild>
          {isEdit ? (
            <Button variant="ghost" size="icon" className="h-8 w-8" title="Edit supplier">
              <Pencil className="h-3.5 w-3.5" />
            </Button>
          ) : (
            <Button variant="outline" size="sm" className="h-8 gap-1">
              <Plus className="h-3.5 w-3.5" /> Add supplier
            </Button>
          )}
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{isEdit ? "Edit supplier" : "Add supplier"}</DialogTitle>
            <DialogDescription>
              {isEdit
                ? <>Update the display name or domain. Format: <span className="font-mono">Target — target.com</span></>
                : <>Adds a new supplier to the dropdown. Format: <span className="font-mono">Target — target.com</span></>}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="sup-name">Display name</Label>
              <Input
                id="sup-name"
                placeholder="e.g. Walmart"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                maxLength={60}
                disabled={submitting}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sup-domain">Domain</Label>
              <Input
                id="sup-domain"
                placeholder="e.g. walmart.com"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !submitting && handleSubmit()}
                maxLength={120}
                disabled={submitting}
              />
              <p className="text-xs text-muted-foreground">
                We'll strip <span className="font-mono">https://</span>, <span className="font-mono">www.</span>, and trailing paths automatically.
              </p>
            </div>
          </div>

          <DialogFooter className="gap-2 sm:justify-between">
            {isEdit ? (
              <Button
                variant="destructive"
                onClick={() => setConfirmDeleteOpen(true)}
                disabled={submitting || deleting}
                className="gap-1"
              >
                <Trash2 className="h-4 w-4" /> Delete
              </Button>
            ) : <span />}

            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
                Cancel
              </Button>
              <Button onClick={handleSubmit} disabled={submitting || !displayName.trim() || !domain.trim()}>
                {submitting ? (
                  <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Saving…</>
                ) : isEdit ? (
                  <><Pencil className="h-4 w-4 mr-1" /> Save changes</>
                ) : (
                  <><Plus className="h-4 w-4 mr-1" /> Add supplier</>
                )}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmDeleteOpen} onOpenChange={setConfirmDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this supplier?</AlertDialogTitle>
            <AlertDialogDescription>
              {editTarget ? (
                <>This will permanently remove <span className="font-mono">{editTarget.display_name} — {editTarget.domain}</span> from the dropdown. Existing scans are not affected.</>
              ) : "This action cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); handleDelete(); }}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Deleting…</> : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {createCatFor && (
        <CreateCategoryDialog
          open={createCatOpen}
          onOpenChange={(o) => {
            setCreateCatOpen(o);
            if (!o) setCreateCatFor(null);
          }}
          supplierDomain={createCatFor.domain}
          supplierDisplayName={createCatFor.displayName}
          onCreated={() => {
            // Re-trigger parent refresh so the newly-curated supplier shows
            // wherever the parent lists user-visible suppliers.
            onAdded(createCatFor.domain);
          }}
        />
      )}
    </>
  );
}
