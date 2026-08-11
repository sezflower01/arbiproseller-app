import { useState } from "react";
import { MessageCircle, Mail, Send, Loader2 } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { sendContactFormEmail } from "@/services/emailService";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

const SUPPORT_EMAIL = "support@inventorysprint.com";

export default function SupportSettings() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [contactOpen, setContactOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const defaultName = (user?.user_metadata as any)?.full_name || user?.email?.split("@")[0] || "";
  const [name, setName] = useState(defaultName);
  const [email, setEmail] = useState(user?.email || "");
  const [message, setMessage] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !email.trim() || message.trim().length < 10) {
      toast({
        title: "Missing details",
        description: "Please fill in your name, email, and a message (at least 10 characters).",
        variant: "destructive",
      });
      return;
    }

    setSubmitting(true);
    try {
      const result = await sendContactFormEmail(SUPPORT_EMAIL, name.trim(), email.trim(), message.trim());
      if (!result.success) throw new Error(result.error || "Failed to send message");

      toast({
        title: "Message sent",
        description: "Thanks for reaching out — we'll get back to you as soon as possible.",
      });
      setMessage("");
      setContactOpen(false);
    } catch (err) {
      toast({
        title: "Couldn't send message",
        description: err instanceof Error ? err.message : "Please try again or email us directly.",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-bold text-white mb-1">Support</h2>
        <p className="text-sm text-gray-400">Get help from our team.</p>
      </div>

      <div className="rounded-xl border border-white/10 bg-white/5 backdrop-blur-sm divide-y divide-white/10">
        {/* Chat with Support */}
        <button
          onClick={() => {
            // Dispatch custom event that chat widget listens for
            window.dispatchEvent(new CustomEvent("open-support-chat"));
          }}
          className="w-full flex items-center gap-4 px-5 py-4 hover:bg-white/5 transition-colors text-left"
        >
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
            <MessageCircle className="h-5 w-5 text-primary" />
          </div>
          <div>
            <p className="text-sm font-semibold text-white">Chat with Support</p>
            <p className="text-xs text-gray-400">Opens the chat</p>
          </div>
        </button>

        {/* Email Support */}
        <a
          href={`mailto:${SUPPORT_EMAIL}`}
          className="w-full flex items-center gap-4 px-5 py-4 hover:bg-white/5 transition-colors"
        >
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
            <Mail className="h-5 w-5 text-primary" />
          </div>
          <div>
            <p className="text-sm font-semibold text-white">Email Support</p>
            <p className="text-xs text-gray-400">{user?.email || SUPPORT_EMAIL}</p>
          </div>
        </a>

        {/* Contact Form */}
        <button
          onClick={() => setContactOpen(true)}
          className="w-full flex items-center gap-4 px-5 py-4 hover:bg-white/5 transition-colors text-left"
        >
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
            <Send className="h-5 w-5 text-primary" />
          </div>
          <div>
            <p className="text-sm font-semibold text-white">Contact</p>
            <p className="text-xs text-gray-400">Send us a message</p>
          </div>
        </button>
      </div>

      <Dialog open={contactOpen} onOpenChange={setContactOpen}>
        <DialogContent className="bg-[#0f0f14] border-white/10 text-white sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-white">Contact Support</DialogTitle>
            <DialogDescription className="text-gray-400">
              Send us a message and we'll reply to your email as soon as possible.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="contact-name" className="text-gray-300">Name</Label>
              <Input
                id="contact-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
                className="bg-white/5 border-white/10 text-white placeholder:text-gray-500"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="contact-email" className="text-gray-300">Email</Label>
              <Input
                id="contact-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="bg-white/5 border-white/10 text-white placeholder:text-gray-500"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="contact-message" className="text-gray-300">Message</Label>
              <Textarea
                id="contact-message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="How can we help?"
                className="min-h-[120px] bg-white/5 border-white/10 text-white placeholder:text-gray-500"
              />
            </div>
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Sending…
                </>
              ) : (
                <>
                  <Send className="h-4 w-4 mr-2" /> Send Message
                </>
              )}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
