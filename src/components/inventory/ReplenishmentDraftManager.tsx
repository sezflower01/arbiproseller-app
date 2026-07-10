import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { ShipmentDraft } from "@/types/shipment";
import { Save, FolderOpen, Trash2, Plus, Edit } from "lucide-react";
import { toast } from "@/hooks/use-toast";

interface ReplenishmentDraftManagerProps {
  currentDraft: ShipmentDraft | null;
  onLoadDraft: (draft: ShipmentDraft) => void;
  onSaveDraft: (name: string) => void;
  onNewDraft: () => void;
}

const DRAFTS_STORAGE_KEY = 'replenishment-drafts';

export function ReplenishmentDraftManager({
  currentDraft,
  onLoadDraft,
  onSaveDraft,
  onNewDraft,
}: ReplenishmentDraftManagerProps) {
  const [drafts, setDrafts] = useState<ShipmentDraft[]>([]);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [loadDialogOpen, setLoadDialogOpen] = useState(false);
  const [draftName, setDraftName] = useState("");

  useEffect(() => {
    loadDraftsFromStorage();
  }, []);

  const loadDraftsFromStorage = () => {
    try {
      const stored = localStorage.getItem(DRAFTS_STORAGE_KEY);
      if (stored) {
        setDrafts(JSON.parse(stored));
      }
    } catch (e) {
      console.error("Error loading drafts:", e);
    }
  };

  const saveDraftToStorage = (draft: ShipmentDraft) => {
    try {
      const existing = drafts.filter(d => d.id !== draft.id);
      const updated = [draft, ...existing].slice(0, 20); // Keep max 20 drafts
      localStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify(updated));
      setDrafts(updated);
    } catch (e) {
      console.error("Error saving draft:", e);
    }
  };

  const deleteDraft = (draftId: string) => {
    const updated = drafts.filter(d => d.id !== draftId);
    localStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify(updated));
    setDrafts(updated);
    toast({ title: "Draft deleted" });
  };

  const handleSave = () => {
    if (!draftName.trim()) {
      toast({ title: "Please enter a name for the draft", variant: "destructive" });
      return;
    }
    onSaveDraft(draftName.trim());
    setSaveDialogOpen(false);
    setDraftName("");
  };

  const openSaveDialog = () => {
    setDraftName(currentDraft?.name || `Shipment ${new Date().toLocaleDateString()}`);
    setSaveDialogOpen(true);
  };

  return (
    <div className="flex items-center gap-2">
      <Button variant="outline" size="sm" onClick={onNewDraft} className="gap-1">
        <Plus className="h-3 w-3" />
        New
      </Button>
      
      <Button variant="outline" size="sm" onClick={openSaveDialog} className="gap-1">
        <Save className="h-3 w-3" />
        Save Draft
      </Button>
      
      <Button variant="outline" size="sm" onClick={() => setLoadDialogOpen(true)} className="gap-1">
        <FolderOpen className="h-3 w-3" />
        Load Draft ({drafts.length})
      </Button>

      {/* Save Dialog */}
      <Dialog open={saveDialogOpen} onOpenChange={setSaveDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Save Draft</DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <Label htmlFor="draftName">Draft Name</Label>
            <Input
              id="draftName"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              placeholder="Enter draft name..."
              className="mt-2"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSave}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Load Dialog */}
      <Dialog open={loadDialogOpen} onOpenChange={setLoadDialogOpen}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Load Draft</DialogTitle>
          </DialogHeader>
          <div className="py-4 space-y-2">
            {drafts.length === 0 ? (
              <p className="text-muted-foreground text-center py-4">No saved drafts</p>
            ) : (
              drafts.map((draft) => (
                <Card key={draft.id} className="p-3 flex items-center justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{draft.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {draft.products.length} products • Step: {draft.step} • {new Date(draft.updatedAt).toLocaleString()}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 ml-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        onLoadDraft(draft);
                        setLoadDialogOpen(false);
                      }}
                    >
                      Load
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      onClick={() => deleteDraft(draft.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </Card>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function saveDraft(draft: ShipmentDraft) {
  try {
    const stored = localStorage.getItem(DRAFTS_STORAGE_KEY);
    const drafts: ShipmentDraft[] = stored ? JSON.parse(stored) : [];
    const existing = drafts.filter(d => d.id !== draft.id);
    const updated = [draft, ...existing].slice(0, 20);
    localStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify(updated));
  } catch (e) {
    console.error("Error saving draft:", e);
  }
}
