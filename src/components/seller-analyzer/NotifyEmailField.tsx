import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Send } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

/**
 * Mirrors auto_source_config_notify_email_chk. Deliberately permissive -- one
 * @, no whitespace, a dot in the domain. Stricter patterns reject valid
 * addresses (plus-tags, long TLDs), and this is a typo guard, not RFC 5322.
 */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

interface Props {
  value: string | null;
  saving: boolean;
  onSave: (email: string | null) => Promise<void>;
}

export default function NotifyEmailField({ value, saving, onSave }: Props) {
  const [draft, setDraft] = useState(value ?? "");
  const [accountEmail, setAccountEmail] = useState<string>("");
  const [testing, setTesting] = useState(false);
  const { toast } = useToast();

  // Re-sync when the saved value arrives or changes elsewhere, but never while
  // the user is mid-edit with unsaved text.
  useEffect(() => { setDraft(value ?? ""); }, [value]);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setAccountEmail(data?.user?.email || ""));
  }, []);

  const trimmed = draft.trim();
  const invalid = trimmed.length > 0 && !EMAIL_RE.test(trimmed);
  const dirty = trimmed !== (value ?? "");
  // Empty means "clear the override", which is a valid save, not a no-op.
  const effective = trimmed || accountEmail;

  const save = async () => {
    if (invalid) return;
    try {
      await onSave(trimmed || null);
      toast({ title: trimmed ? "Notification email saved" : "Reverted to your account email" });
    } catch (e) {
      toast({ title: "Could not save", description: (e as Error).message, variant: "destructive" });
    }
  };

  const sendTest = async () => {
    if (!effective) return;
    setTesting(true);
    try {
      // Sends the REAL alert template rather than a generic "test" body, so
      // what arrives is what a genuine alert will look like -- including
      // whether it survives the recipient's spam filter, which a plain-text
      // test would not prove.
      const { error } = await supabase.functions.invoke("send-email", {
        body: {
          to: effective,
          name: "there",
          emailType: "seller-watch-new-listings",
          sellerWatch: {
            sellerId: "A1EXAMPLE00000",
            sellerName: "Test seller",
            marketplace: "US",
            newAsins: ["B000EDVTQM"],
            totalNew: 1,
          },
        },
      });
      if (error) throw new Error(error.message);
      toast({ title: `Test sent to ${effective}`, description: "Check the inbox, and the spam folder." });
    } catch (e) {
      toast({ title: "Could not send test", description: (e as Error).message, variant: "destructive" });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="space-y-2 border-t pt-3">
      <div className="text-sm">Send new-listing alerts to</div>
      <div className="flex flex-wrap gap-2">
        <Input
          type="email"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          // Placeholder carries the real fallback, so the default is visible
          // rather than something the user has to infer from an empty box.
          placeholder={accountEmail || "your account email"}
          className="h-9 text-sm flex-1 min-w-[14rem]"
          disabled={saving}
          aria-invalid={invalid}
          aria-label="Notification email"
        />
        <Button type="button" size="sm" variant="secondary" onClick={save} disabled={saving || invalid || !dirty}>
          {saving && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
          Save
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={sendTest} disabled={testing || !effective || dirty}>
          {testing ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Send className="h-3.5 w-3.5 mr-1" />}
          Send test
        </Button>
      </div>

      {invalid ? (
        <p className="text-xs text-destructive">That does not look like an email address.</p>
      ) : dirty ? (
        <p className="text-xs text-muted-foreground">Save before sending a test.</p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {trimmed
            ? "This address is not verified — send a test to confirm it arrives."
            : "Leave blank to use your account email."}
        </p>
      )}
    </div>
  );
}
