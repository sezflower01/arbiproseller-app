import { useEffect, useState } from "react";
import { Helmet } from "react-helmet-async";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Loader2, CheckCircle2, AlertTriangle, ExternalLink } from "lucide-react";
import { Link } from "react-router-dom";

/**
 * /tools/ext-handoff
 *
 * Bridges the user's Supabase session into the ArbiProSeller Chrome Extension.
 *
 * Flow:
 *   1. Extension popup opens this page (?ext=1).
 *   2. If signed in, we postMessage the session to window — the extension's
 *      content script (handoff.js) listens on arbiproseller.com and forwards
 *      it to chrome.storage.local via background.js.
 *   3. We retry every 3s in case the extension is slow to acknowledge.
 *
 * NEVER post anything other than access_token / refresh_token / expires_at.
 * The publishable anon key + the user's own JWT are the only secrets the
 * extension is allowed to hold. Server keys (Keepa, AWS, service role) stay
 * in edge functions.
 */
export default function ExtHandoff() {
  const { user, loading } = useAuth();
  const [status, setStatus] = useState<"idle" | "sent" | "ack" | "no-session">("idle");
  const [attempts, setAttempts] = useState(0);

  useEffect(() => {
    if (loading) return;

    let cancelled = false;
    let interval: number | undefined;

    const sendSession = async () => {
      const { data } = await supabase.auth.getSession();
      const session = data?.session;
      if (!session?.access_token || !session?.refresh_token) {
        if (!cancelled) setStatus("no-session");
        return;
      }
      window.postMessage(
        {
          type: "ARBIPRO_EXT_SESSION",
          session: {
            access_token: session.access_token,
            refresh_token: session.refresh_token,
            expires_at: session.expires_at,
          },
        },
        window.location.origin,
      );
      if (!cancelled) {
        setStatus((s) => (s === "ack" ? s : "sent"));
        setAttempts((n) => n + 1);
      }
    };

    // Listen for ack from the extension's handoff content script.
    const onAck = (e: MessageEvent) => {
      if (e.source !== window) return;
      if (e.data?.type === "ARBIPRO_EXT_SESSION_ACK") setStatus("ack");
    };
    window.addEventListener("message", onAck);

    sendSession();
    interval = window.setInterval(() => {
      if (status !== "ack") sendSession();
    }, 3000);

    return () => {
      cancelled = true;
      window.removeEventListener("message", onAck);
      if (interval) window.clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  return (
    <div className="min-h-screen bg-[#0f1c3f] text-white flex items-center justify-center p-6">
      <Helmet>
        <title>Connect Extension · ArbiProSeller</title>
        <meta name="robots" content="noindex" />
      </Helmet>
      <main className="max-w-md w-full bg-[#15224a] border border-white/10 rounded-2xl p-8 shadow-2xl">
        <h1 className="text-2xl font-semibold mb-2">Connect Chrome Extension</h1>
        <p className="text-sm text-white/70 mb-6">
          This page hands your Inventory S.P.R.I.N.T. session to the Chrome extension so
          it can show scanner data on Amazon product pages.
        </p>

        {loading && (
          <div className="flex items-center gap-2 text-white/80">
            <Loader2 className="w-4 h-4 animate-spin" /> Checking session…
          </div>
        )}

        {!loading && !user && (
          <div className="space-y-4">
            <div className="flex items-start gap-2 text-amber-300">
              <AlertTriangle className="w-5 h-5 mt-0.5" />
              <div>
                <p className="font-medium">You're not signed in.</p>
                <p className="text-sm text-white/70">
                  Sign in first, then re-open this page from the extension.
                </p>
              </div>
            </div>
            <Link
              to="/login?redirect=/tools/ext-handoff?ext=1"
              className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded-lg font-medium"
            >
              Sign in <ExternalLink className="w-4 h-4" />
            </Link>
          </div>
        )}

        {!loading && user && status === "ack" && (
          <div className="flex items-start gap-2 text-emerald-300">
            <CheckCircle2 className="w-5 h-5 mt-0.5" />
            <div>
              <p className="font-medium">Extension connected ✓</p>
              <p className="text-sm text-white/70">
                You can close this tab and open any Amazon product page.
              </p>
            </div>
          </div>
        )}

        {!loading && user && status !== "ack" && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-white/80">
              <Loader2 className="w-4 h-4 animate-spin" />
              {status === "no-session"
                ? "No active session — try signing in again."
                : `Sending session to extension… (attempt ${attempts})`}
            </div>
            <p className="text-xs text-white/50">
              If nothing happens within 10 seconds, make sure the Inventory S.P.R.I.N.T.
              extension is installed and enabled in <code>chrome://extensions</code>.
            </p>
          </div>
        )}

        <hr className="border-white/10 my-6" />
        <p className="text-xs text-white/50">
          Signed in as <span className="text-white/80">{user?.email || "—"}</span>.
          Only your session token is shared with the extension. Server keys
          (Keepa, SP-API, AWS) never leave the backend.
        </p>
      </main>
    </div>
  );
}
