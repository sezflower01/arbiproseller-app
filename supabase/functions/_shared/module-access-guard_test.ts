// Tests for the shared module-access guard.
//
// Run via the supabase__test_edge_functions tool. We mock a tiny supabase
// client so tests are fast, deterministic, and don't hit the real DB.

import {
  assertEquals,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import { checkModuleAccess } from "./module-access-guard.ts";

type Row = Record<string, unknown> | null;

interface MockTable {
  rows: Row[];
}

function makeSupabaseMock(opts: {
  isAdmin: boolean;
  rpcAllowed: boolean;
  rpcError?: string;
  fallbackHasRow?: boolean;
}) {
  const calls: string[] = [];
  return {
    calls,
    from(tableName: string) {
      calls.push(`from:${tableName}`);
      const builder: any = {
        _table: tableName,
        select() { return this; },
        eq() { return this; },
        async maybeSingle() {
          if (tableName === "user_roles") {
            return { data: opts.isAdmin ? { role: "admin" } : null, error: null };
          }
          if (tableName === "user_module_access") {
            return {
              data: opts.fallbackHasRow ? { action: "view" } : null,
              error: null,
            };
          }
          return { data: null, error: null };
        },
      };
      return builder;
    },
    async rpc(_name: string, _args: unknown) {
      calls.push(`rpc:${_name}`);
      if (opts.rpcError) return { data: null, error: { message: opts.rpcError } };
      return { data: opts.rpcAllowed, error: null };
    },
  };
}

Deno.test("admin user passes any module/action", async () => {
  const sb = makeSupabaseMock({ isAdmin: true, rpcAllowed: false });
  const r = await checkModuleAccess(sb as any, "u-admin", "personalhour", "view");
  assert(r.allowed);
  assertEquals(r.isAdmin, true);
});

Deno.test("non-admin without grant is denied", async () => {
  const sb = makeSupabaseMock({ isAdmin: false, rpcAllowed: false });
  const r = await checkModuleAccess(sb as any, "u-1", "personalhour", "view");
  assertEquals(r.allowed, false);
  assertEquals(r.isAdmin, false);
  assert(r.reason?.includes("personalhour:view"));
});

Deno.test("non-admin with matching grant is allowed", async () => {
  const sb = makeSupabaseMock({ isAdmin: false, rpcAllowed: true });
  const r = await checkModuleAccess(sb as any, "u-2", "supplier_discovery", "run");
  assert(r.allowed);
  assertEquals(r.isAdmin, false);
});

Deno.test("missing userId is denied", async () => {
  const sb = makeSupabaseMock({ isAdmin: true, rpcAllowed: true });
  const r = await checkModuleAccess(sb as any, "", "repricer", "run");
  assertEquals(r.allowed, false);
});

Deno.test("RPC failure falls back to direct lookup (allowed when row exists)", async () => {
  const sb = makeSupabaseMock({
    isAdmin: false,
    rpcAllowed: false,
    rpcError: "rpc broke",
    fallbackHasRow: true,
  });
  const r = await checkModuleAccess(sb as any, "u-3", "repricer", "edit");
  assert(r.allowed);
});

Deno.test("RPC failure falls back to direct lookup (denied when no row)", async () => {
  const sb = makeSupabaseMock({
    isAdmin: false,
    rpcAllowed: false,
    rpcError: "rpc broke",
    fallbackHasRow: false,
  });
  const r = await checkModuleAccess(sb as any, "u-4", "repricer", "edit");
  assertEquals(r.allowed, false);
});

Deno.test("view grant does NOT satisfy a run check", async () => {
  // Simulates: user has personalhour:view, but the RPC says false for personalhour:run.
  const sb = makeSupabaseMock({ isAdmin: false, rpcAllowed: false });
  const r = await checkModuleAccess(sb as any, "u-5", "personalhour", "run");
  assertEquals(r.allowed, false);
});
