import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export type ExclusionKind = "category" | "brand" | "title_keyword";

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
 * Title keywords normalise differently, mirroring
 * supabase/functions/_shared/title-exclusions.ts (the source of truth, which
 * the edge functions import directly). Duplicated here rather than imported
 * because that module is Deno edge code and does not belong in the browser
 * bundle — but ONLY the normalisation is copied, never the matching rule.
 *
 * Diacritics are stripped so "Pokémon" and "pokemon" are one entry rather than
 * two that both appear to work.
 */
export function normalizeTitleTerm(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** The stored `value` for a term of this kind. */
export function normalizeForKind(kind: ExclusionKind, raw: string): string {
  return kind === "title_keyword" ? normalizeTitleTerm(raw) : normalizeTerm(raw);
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
    const value = normalizeForKind(kind, raw);
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

  /**
   * Exclude or re-allow a whole set of API values at once.
   *
   * A friendly category label maps to several real websiteDisplayGroupName
   * values ("Movies & TV" -> dvd, video, video dvd, blu-ray), so a toggle has
   * to move all of them together. Done as one insert and one delete rather
   * than a loop of single calls, so a half-applied toggle cannot leave a label
   * in a state its own switch does not describe.
   */
  const setExcluded = useCallback(async (kind: ExclusionKind, values: string[], excluded: boolean) => {
    if (!values.length) return;
    const { data: auth } = await supabase.auth.getUser();
    const userId = auth?.user?.id;
    if (!userId) throw new Error("Please log in to change this setting.");

    setBusy(true);
    try {
      if (excluded) {
        const existing = new Set(terms.filter((t) => t.kind === kind).map((t) => t.value));
        const rows = values
          .filter((v) => !existing.has(v))
          .map((v) => ({ user_id: userId, kind, value: v, label: v }));
        if (rows.length) {
          const { error } = await supabase.from("source_excluded_terms").insert(rows);
          if (error) throw new Error(error.message);
        }
      } else {
        const { error } = await supabase
          .from("source_excluded_terms")
          .delete()
          .eq("kind", kind)
          .in("value", values);
        if (error) throw new Error(error.message);
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [terms, refresh]);

  /**
   * How many current listings a rule would hit. null = none seen in your data.
   *
   * Title keywords deliberately return null: the preview RPC counts distinct
   * category and brand VALUES, which a word-boundary match inside a sentence
   * cannot be expressed as. Guessing with a SQL LIKE would show a number that
   * disagrees with the rule that actually runs, which is worse than showing
   * none — the "Apply to existing listings" preview uses the real matcher
   * instead.
   */
  const impactOf = useCallback((kind: ExclusionKind, value: string): number | null => {
    if (kind === "title_keyword") return null;
    const list = kind === "category" ? categoryCounts : brandCounts;
    const hit = list.find((e) => e.value === value);
    return hit ? hit.n : null;
  }, [categoryCounts, brandCounts]);

  return {
    terms, categoryCounts, brandCounts, loading, busy,
    add, remove, setExcluded, refresh, impactOf,
  };
}
