import { useMemo, useState } from "react";
import { useEffect } from "react";
import { Helmet } from "react-helmet-async";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { supabase } from "@/integrations/supabase/client";

type TestResult = {
  name: string;
  ok: boolean;
  status?: number;
  detail: string;
  raw?: string;
};

function formatError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

export default function Diagnostics() {
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<TestResult[] | null>(null);
  const [serviceWorkers, setServiceWorkers] = useState<ServiceWorkerRegistration[]>([]);
  const [swLoading, setSwLoading] = useState(false);

  const envInfo = useMemo(() => {
    // Vite env values are embedded at build time; safe to display URL, do not display keys.
    const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
    const projectId = import.meta.env.VITE_SUPABASE_PROJECT_ID as string | undefined;
    return {
      supabaseUrl: url || "(missing VITE_SUPABASE_URL)",
      projectId: projectId || "(missing VITE_SUPABASE_PROJECT_ID)",
      userAgent: navigator.userAgent,
      online: navigator.onLine,
    };
  }, []);

  // Check for service workers on mount
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.getRegistrations().then((regs) => setServiceWorkers([...regs]));
    }
  }, []);

  const unregisterAllSW = async () => {
    setSwLoading(true);
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
      setServiceWorkers([]);
      alert("Service workers unregistered. Refreshing page...");
      window.location.reload();
    } catch (e) {
      alert("Error: " + formatError(e));
    } finally {
      setSwLoading(false);
    }
  };

  const clearSiteData = async () => {
    try {
      // Clear localStorage
      localStorage.clear();
      // Clear sessionStorage
      sessionStorage.clear();
      // Clear caches if available
      if ("caches" in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
      alert("Site data cleared. Refreshing page...");
      window.location.reload();
    } catch (e) {
      alert("Error: " + formatError(e));
    }
  };

  const run = async () => {
    setRunning(true);
    setResults(null);

    const next: TestResult[] = [];

    // 1) Raw fetch against Supabase Auth health endpoint (default mode).
    try {
      const url = `${envInfo.supabaseUrl}/auth/v1/health`;
      const res = await fetch(url, {
        method: "GET",
        cache: "no-store",
      });
      const text = await res.text();
      next.push({
        name: "Fetch /auth/v1/health (cors)",
        ok: res.ok,
        status: res.status,
        detail: res.ok ? "Reachable" : "HTTP error",
        raw: text?.slice(0, 500) || "(no body)",
      });
    } catch (e) {
      next.push({
        name: "Fetch /auth/v1/health (cors)",
        ok: false,
        detail: formatError(e),
      });
    }

    // 2) Try no-cors mode (opaque response but shows if network layer works)
    try {
      const url = `${envInfo.supabaseUrl}/auth/v1/health`;
      const res = await fetch(url, {
        method: "GET",
        mode: "no-cors",
        cache: "no-store",
      });
      // no-cors always returns opaque response with status 0
      next.push({
        name: "Fetch /auth/v1/health (no-cors)",
        ok: true,
        status: res.status,
        detail: "Network layer reached (opaque response expected)",
      });
    } catch (e) {
      next.push({
        name: "Fetch /auth/v1/health (no-cors)",
        ok: false,
        detail: formatError(e) + " — network layer blocked",
      });
    }

    // 3) Try HEAD request (sometimes blocked differently)
    try {
      const url = `${envInfo.supabaseUrl}/auth/v1/health`;
      const res = await fetch(url, {
        method: "HEAD",
        cache: "no-store",
      });
      next.push({
        name: "HEAD /auth/v1/health",
        ok: res.ok,
        status: res.status,
        detail: res.ok ? "Reachable" : "HTTP error",
      });
    } catch (e) {
      next.push({
        name: "HEAD /auth/v1/health",
        ok: false,
        detail: formatError(e),
      });
    }

    // 4) Try REST endpoint (different path)
    try {
      const url = `${envInfo.supabaseUrl}/rest/v1/`;
      const res = await fetch(url, {
        method: "GET",
        cache: "no-store",
        headers: {
          apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || "",
        },
      });
      const text = await res.text();
      next.push({
        name: "Fetch /rest/v1/ (PostgREST)",
        ok: res.ok || res.status === 400, // 400 is expected without table name
        status: res.status,
        detail: res.ok ? "Reachable" : `Status ${res.status}`,
        raw: text?.slice(0, 300) || "(no body)",
      });
    } catch (e) {
      next.push({
        name: "Fetch /rest/v1/ (PostgREST)",
        ok: false,
        detail: formatError(e),
      });
    }

    // 5) Supabase-js session read (localStorage + client).
    try {
      const { data, error } = await supabase.auth.getSession();
      if (error) throw error;
      next.push({
        name: "supabase.auth.getSession",
        ok: true,
        detail: data.session ? "Session exists" : "No session (expected if logged out)",
      });
    } catch (e) {
      next.push({
        name: "supabase.auth.getSession",
        ok: false,
        detail: formatError(e),
      });
    }

    // 6) Check if we can reach a generic external site (to rule out total network block)
    try {
      const res = await fetch("https://www.google.com/generate_204", {
        method: "GET",
        mode: "no-cors",
        cache: "no-store",
      });
      next.push({
        name: "Fetch google.com (no-cors)",
        ok: true,
        detail: "External network works",
      });
    } catch (e) {
      next.push({
        name: "Fetch google.com (no-cors)",
        ok: false,
        detail: formatError(e) + " — total network block?",
      });
    }

    setResults(next);
    setRunning(false);
  };

  const anyFail = (results || []).some((r) => !r.ok);

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <Helmet>
        <title>Diagnostics - ArbiProSeller</title>
        <meta
          name="description"
          content="Connectivity diagnostics for ArbiProSeller authentication."
        />
      </Helmet>

      <Navbar />

      <main className="flex-1 pt-16">
        <div className="container mx-auto px-4 py-10 max-w-3xl">
          <h1 className="text-3xl font-bold text-foreground">Diagnostics</h1>
          <p className="mt-2 text-muted-foreground">
            Esta página prueba si tu navegador/red puede alcanzar Supabase. Si aquí falla,
            el “Login failed: Failed to fetch” no es tu contraseña—es conectividad.
          </p>

          <div className="mt-6 flex items-center gap-3">
            <Button onClick={run} disabled={running}>
              {running ? "Running…" : "Run tests"}
            </Button>
            <Button variant="outline" onClick={clearSiteData}>
              Clear site data
            </Button>
          </div>

          {/* Service Worker section */}
          {serviceWorkers.length > 0 && (
            <Alert variant="destructive" className="mt-6">
              <AlertTitle>Service Workers detected ({serviceWorkers.length})</AlertTitle>
              <AlertDescription className="space-y-2">
                <p>
                  Service workers can intercept/block network requests. This is a common
                  cause of domain-specific "Failed to fetch" errors.
                </p>
                <ul className="list-disc pl-5 text-xs">
                  {serviceWorkers.map((sw, i) => (
                    <li key={i} className="font-mono break-all">
                      {sw.scope}
                    </li>
                  ))}
                </ul>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={unregisterAllSW}
                  disabled={swLoading}
                  className="mt-2"
                >
                  {swLoading ? "Removing…" : "Unregister all & reload"}
                </Button>
              </AlertDescription>
            </Alert>
          )}

          <Card className="mt-6">
            <CardHeader>
              <CardTitle>Environment</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div>
                <span className="text-muted-foreground">Supabase URL:</span>{" "}
                <span className="font-mono break-all">{envInfo.supabaseUrl}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Project ID:</span>{" "}
                <span className="font-mono">{envInfo.projectId}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Online:</span>{" "}
                <span className="font-mono">{String(envInfo.online)}</span>
              </div>
              <div>
                <span className="text-muted-foreground">User-Agent:</span>{" "}
                <span className="font-mono break-words">{envInfo.userAgent}</span>
              </div>
            </CardContent>
          </Card>

          {results && (
            <div className="mt-6 space-y-4">
              {anyFail ? (
                <Alert variant="destructive">
                  <AlertTitle>At least one test failed</AlertTitle>
                  <AlertDescription>
                    Copia y pégame los resultados (especialmente el primero). Esto
                    identifica si es bloqueo por red/ISP, proxy corporativo, o una
                    extensión.
                  </AlertDescription>
                </Alert>
              ) : (
                <Alert>
                  <AlertTitle>All good</AlertTitle>
                  <AlertDescription>
                    Conectividad OK. Si el login sigue fallando, el error ya no es
                    “fetch bloqueado” sino credenciales/estado de sesión.
                  </AlertDescription>
                </Alert>
              )}

              {results.map((r) => (
                <Card key={r.name}>
                  <CardHeader>
                    <CardTitle className="text-base">
                      {r.ok ? "OK" : "FAIL"} — {r.name}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2 text-sm">
                    {typeof r.status === "number" && (
                      <div>
                        <span className="text-muted-foreground">Status:</span>{" "}
                        <span className="font-mono">{r.status}</span>
                      </div>
                    )}
                    <div>
                      <span className="text-muted-foreground">Detail:</span>{" "}
                      <span className="font-mono break-words">{r.detail}</span>
                    </div>
                    {r.raw && (
                      <div>
                        <span className="text-muted-foreground">Body (first 500 chars):</span>
                        <pre className="mt-2 whitespace-pre-wrap rounded-md border bg-card p-3 font-mono text-xs">
                          {r.raw}
                        </pre>
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      </main>

      <Footer />
    </div>
  );
}
