import { MessageCircle, Mail } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";

export default function SupportSettings() {
  const { user } = useAuth();

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
          href="mailto:support@arbiproseller.com"
          className="w-full flex items-center gap-4 px-5 py-4 hover:bg-white/5 transition-colors"
        >
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
            <Mail className="h-5 w-5 text-primary" />
          </div>
          <div>
            <p className="text-sm font-semibold text-white">Email Support</p>
            <p className="text-xs text-gray-400">{user?.email || "support@arbiproseller.com"}</p>
          </div>
        </a>
      </div>
    </div>
  );
}
