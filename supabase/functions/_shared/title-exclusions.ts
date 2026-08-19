// Title keyword/phrase exclusion.
//
// SEPARATE FROM THE BRAND LIST ON PURPOSE, because the matching rule has to be
// different and a shared list would have to pick one:
//
//   brands  exact match on the whole field. A brand IS the value, so equality
//           is natural, and substring would catch "Publisher Unknown" with a
//           rule meant for "Unknown".
//   titles  the term is always a FRAGMENT of a 100+ character sentence, so
//           equality matches essentially nothing.
//
// WORD BOUNDARY, not naive substring. Measured 2026-08-19 against real listing
// titles: naive `includes()` produced false positives on 2 of 6 sampled terms.
//   "stand" matched "Standing Desk Converter"
//   "ink"   matched "Thinking Putty for Kids"
// Those are exactly the short common words someone reaches for first, and the
// failure is invisible -- an over-excluded listing simply never appears.
//
// Word boundaries keep the brand list's actual principle (do not match inside
// another word) while allowing the fragment matching that titles require.

/**
 * Lowercase and strip diacritics.
 *
 * Without this, a user typing "pokemon" would NOT match "Pokémon" -- é is not
 * e, and JavaScript's \b is ASCII-only so the boundary would not land either.
 * Real titles in this data carry accents, em-dashes and brackets.
 */
export function normalizeForTitleMatch(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the boundary-anchored matcher for one already-normalised term.
 *
 * NOT a plain `\b...\b`. `\b` asserts a word/non-word TRANSITION, so it only
 * lands when the character on that side of the term is itself a word char. A
 * term that starts or ends with punctuation -- "(refurb)", "+bonus", "#12" --
 * would then be unmatchable, because `\b(` demands a word character before an
 * open paren that can never be one. Caught by test, not by reading.
 *
 * So each side is anchored only when that side of the TERM is a word char:
 *   "stand"    -> (?<!\w)stand(?!\w)     still refuses "Standing"
 *   "(refurb)" -> \(refurb\)             no anchor needed; the parens are the
 *                                        boundary
 *
 * `\w` is ASCII-only. Diacritics are already stripped by normalisation, so
 * Latin text is fine; for a non-Latin script (Korean, Japanese) `\w` sees no
 * word chars and the match degrades to plain substring. That is the permissive
 * direction, and the term is still matched literally.
 */
function termRegex(normalisedTerm: string): RegExp {
  const body = escapeRegExp(normalisedTerm);
  const left = /^\w/.test(normalisedTerm) ? '(?<!\\w)' : '';
  const right = /\w$/.test(normalisedTerm) ? '(?!\\w)' : '';
  return new RegExp(`${left}${body}${right}`);
}

/**
 * Does `title` contain `term` as a whole word or whole phrase?
 *
 * Deliberately does NOT match plurals: `card` will not match "cards", because
 * `s` is a word character so the trailing boundary does not land. Predictable
 * beats clever -- the same reason the brand list stayed exact -- and a user who
 * wants both adds both. Loosening this to a prefix match would reintroduce
 * "cardboard".
 */
export function titleMatchesTerm(title: string | null | undefined, term: string): boolean {
  const t = normalizeForTitleMatch(String(title ?? ''));
  const q = normalizeForTitleMatch(String(term ?? ''));
  if (!t || !q) return false;
  return termRegex(q).test(t);
}

/**
 * The first term that matches, or null.
 *
 * Returns WHICH term matched rather than a boolean so the stored
 * disqualified_reason can name it -- "excluded_title:refurbished" tells the
 * user which of their own rules fired, which a bare "excluded" never could.
 */
export function findExcludedTitleTerm(
  title: string | null | undefined,
  terms: Iterable<string> | null | undefined,
): string | null {
  // A MISSING title never excludes. SP-API sometimes resolves the title a cycle
  // after detection, and rejecting for absent data rather than for evidence is
  // the same mistake the rank ceiling and the brand rule both avoid.
  const t = normalizeForTitleMatch(String(title ?? ''));
  if (!t) return null;
  for (const raw of terms ?? []) {
    const q = normalizeForTitleMatch(String(raw ?? ''));
    if (!q) continue;
    if (termRegex(q).test(t)) return raw;
  }
  return null;
}
