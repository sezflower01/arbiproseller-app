import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export type ExclusionKind = "category" | "brand";

export interface ExcludedTerm {
  id: string;
  kind: ExclusionKind;
  value: string;
  label: string | null;
}

/** A value present in the user's own listings, with how many carry it. */
export interface PreviewEntry {
  value: string;
  label: string;
  n: number;
}

/** Matching must agree exactly with source-qualification.ts: trim + lowercase. */
export function normalizeTerm(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Category and brand exclusions, plus what each rule would actually affect.
 *
 * The preview exists because Amazon's productGroup is coarse and sometimes
 * wrong — live data returned "Apparel" for a LEGO minifigure and "Shoes" for
 * reading glasses. Excluding a category by name is a guess unless you can see
 * what actually carries that label in your own listings.
 */
export function useQualificationExclusions() {
  const [terms, setTerms] = useState<ExcludedTerm[]>([]);
  const [categoryCounts, setCategoryCounts] = useState<PreviewEntry[]>([]);
  const [brandCounts, setBrandCounts] = useState<PreviewEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [{ data, error }, { data: preview }] = await Promise.all([
        supabase
          .from("source_excluded_terms")
          .select("id, kind, value, label")
          .order("kind", { ascending: true })
          .order("value", { ascending: true }),
        supabase.rpc("qualification_exclusion_preview"),
      ]);
      if (error) throw new Error(error.message);
      setTerms((data || []) as ExcludedTerm[]);
      const p = (preview || {}) as { categories?: PreviewEntry[]; brands?: PreviewEntry[] };
      setCategoryCounts(p.categories || []);
      setBrandCounts(p.brands || []);
    } catch (e) {
      console.error("[useQualificationExclusions] refresh failed", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const add = useCallback(async (kind: ExclusionKind, raw: string) => {
    const value = normalizeTerm(raw);
    if (!value) throw new Error("Enter a value first.");
    if (terms.some((t) => t.kind === kind && t.value === value)) {
      throw new Error(`"${raw.trim()}" is already excluded.`);
    }
    const { data: auth } = await supabase.auth.getUser();
    const userId = auth?.user?.id;
    if (!userId) throw new Error("Please log in to change this setting.");

    setBusy(true);
    try {
      const { error } = await supabase
        .from("source_excluded_terms")
        .insert({ user_id: userId, kind, value, label: raw.trim() });
      if (error) throw new Error(error.message);
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [terms, refresh]);

  const remove = useCallback(async (id: string) => {
    setBusy(true);
    try {
      const { error } = await supabase.from("source_excluded_terms").delete().eq("id", id);
      if (error) throw new Error(error.message);
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  /** How many current listings a rule would hit. null = none seen in your data. */
  const impactOf = useCallback((kind: ExclusionKind, value: string): number | null => {
    const list = kind === "category" ? categoryCounts : brandCounts;
    const hit = list.find((e) => e.value === value);
    return hit ? hit.n : null;
  }, [categoryCounts, brandCounts]);

  return {
    terms, categoryCounts, brandCounts, loading, busy,
    add, remove, refresh, impactOf,
  };
}
