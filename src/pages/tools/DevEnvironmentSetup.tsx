import { useState, useEffect } from "react";
import { Helmet } from "react-helmet-async";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Terminal, Copy, Check, ExternalLink } from "lucide-react";

const SETUP_SCRIPT_URL = "https://inventorysprint.com/setup.ps1";
const ONE_LINER = `irm ${SETUP_SCRIPT_URL} | iex`;

function CopyBlock({ code, label }: { code: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    toast.success(`${label} copied`);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="relative">
      <pre className="text-xs sm:text-sm bg-muted/30 border border-border rounded-lg p-4 pr-14 overflow-x-auto font-mono text-foreground">
        {code}
      </pre>
      <Button
        size="sm"
        variant="outline"
        className="absolute top-2 right-2 h-8 gap-1"
        onClick={handleCopy}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

const MANUAL_STEPS: { title: string; detail: string }[] = [
  {
    title: "Install Node.js (LTS)",
    detail: "Download and run the installer from nodejs.org, or in PowerShell: winget install -e --id OpenJS.NodeJS.LTS",
  },
  {
    title: "Install Git",
    detail: "Download and run the installer from git-scm.com/download/win, or in PowerShell: winget install -e --id Git.Git",
  },
  {
    title: "Restart PowerShell",
    detail: "Close and reopen your terminal so node/npm/git are picked up on PATH — this is the most common thing people skip.",
  },
  {
    title: "Install Claude Code",
    detail: "npm install -g @anthropic-ai/claude-code",
  },
  {
    title: "Create a dev folder",
    detail: "mkdir $HOME\\dev then cd $HOME\\dev",
  },
  {
    title: "Clone arbiproseller-app",
    detail: "git clone https://github.com/sezflower01/arbiproseller-app.git — a browser sign-in window will open since it's private.",
  },
  {
    title: "Clone new-venture-generator",
    detail: "git clone https://github.com/sezflower01/new-venture-generator.git",
  },
  {
    title: "Install dependencies in each repo",
    detail: "cd arbiproseller-app && npm install, then cd ..\\new-venture-generator && npm install",
  },
];

export default function DevEnvironmentSetup() {
  const { user } = useAuth();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  useEffect(() => {
    if (!user) { setIsAdmin(false); return; }
    supabase.from("user_roles").select("role").eq("user_id", user.id).eq("role", "admin").maybeSingle()
      .then(({ data }) => setIsAdmin(!!data));
  }, [user]);

  if (isAdmin === null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <>
        <Navbar />
        <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-background">
          <h1 className="text-2xl font-bold text-foreground">Access Restricted</h1>
          <p className="text-muted-foreground">You need the <strong>admin</strong> role to view this page.</p>
        </div>
        <Footer />
      </>
    );
  }

  return (
    <>
      <Helmet>
        <title>Dev Environment Setup — ArbiProSeller</title>
      </Helmet>
      <div className="min-h-screen flex flex-col bg-background">
        <Navbar />
        <main className="flex-1 container mx-auto px-4 py-8 pt-24 max-w-3xl space-y-8">
          <div>
            <h1 className="text-3xl font-bold text-foreground flex items-center gap-3">
              <Terminal className="h-8 w-8 text-primary" />
              Dev Environment Setup
            </h1>
            <p className="text-muted-foreground mt-1">
              Bootstrap a new Windows machine for arbiproseller-app and new-venture-generator development —
              Node.js, Git, Claude Code, both repos cloned, dependencies installed.
            </p>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">One-liner (recommended)</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                On a fresh Windows machine, open PowerShell and paste this in:
              </p>
              <CopyBlock code={ONE_LINER} label="Command" />
              <p className="text-xs text-muted-foreground">
                Both repos are private — cloning will open a browser window asking you to sign in to GitHub.
                That's expected. Every step is safe to re-run if something fails partway through — already-installed
                tools and already-cloned repos are skipped, not redone.
              </p>
              <a
                href={SETUP_SCRIPT_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
              >
                View the actual script <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Manual steps (if the one-liner fails)</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground mb-4">
                The same steps we did by hand on day one — work through them in order.
              </p>
              <ol className="space-y-4">
                {MANUAL_STEPS.map((step, i) => (
                  <li key={step.title} className="flex gap-3">
                    <span className="flex-shrink-0 h-6 w-6 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center mt-0.5">
                      {i + 1}
                    </span>
                    <div className="min-w-0">
                      <div className="font-medium text-foreground">{step.title}</div>
                      <code className="text-xs text-muted-foreground break-all">{step.detail}</code>
                    </div>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </main>
        <Footer />
      </div>
    </>
  );
}
