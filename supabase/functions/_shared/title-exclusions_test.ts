import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import {
  titleMatchesTerm,
  findExcludedTitleTerm,
  normalizeForTitleMatch,
} from './title-exclusions.ts';

// Real titles observed in this account's live data on 2026-08-19.
const POKEMON = 'Pokémon TCG: Mega Evolution—Pitch Black Elite Trainer Box';
const KNIFE = 'Outdoor Edge SlideWinder - Utility Knife Multitool with Stand';
const KPOP = "JYP Ent ITZY - IT'Z ME [Random ver.] Album+Pre-Order Benefit";
const PATTERN = 'Simplicity 4562 Easy Size A 3-8 Sewing Pattern';

// ── The false positives that justify word boundaries ──

Deno.test('does NOT match inside another word -- the whole point', () => {
  // Naive includes() matched both of these; that is the bug being prevented.
  assertEquals(titleMatchesTerm('Standing Desk Converter, Height Adjustable', 'stand'), false);
  assertEquals(titleMatchesTerm('Thinking Putty for Kids - Sensory Toy', 'ink'), false);
  assertEquals(titleMatchesTerm('Cardboard Storage Box', 'card'), false);
});

Deno.test('DOES match the same words when they stand alone', () => {
  assertEquals(titleMatchesTerm(KNIFE, 'stand'), true);
  assertEquals(titleMatchesTerm('Refill Ink for Printer', 'ink'), true);
});

// ── Diacritics ──

Deno.test('typing pokemon matches Pokémon', () => {
  assertEquals(titleMatchesTerm(POKEMON, 'pokemon'), true);
});

Deno.test('and the reverse, so either spelling in the list works', () => {
  assertEquals(titleMatchesTerm('Pokemon Card Binder', 'pokémon'), true);
});

Deno.test('normalizeForTitleMatch strips accents, lowercases, collapses spaces', () => {
  assertEquals(normalizeForTitleMatch('  Pokémon   TCG  '), 'pokemon tcg');
});

// ── Phrases, punctuation, case ──

Deno.test('multi-word phrases match', () => {
  assertEquals(titleMatchesTerm(PATTERN, 'sewing pattern'), true);
  assertEquals(titleMatchesTerm(PATTERN, 'sewing machine'), false);
});

Deno.test('hyphenated terms match', () => {
  assertEquals(titleMatchesTerm(KPOP, 'pre-order'), true);
});

Deno.test('matching is case-insensitive', () => {
  assertEquals(titleMatchesTerm(POKEMON, 'ELITE TRAINER BOX'), true);
});

Deno.test('regex metacharacters in a term are literal, not patterns', () => {
  // A user typing "3-8" or "(refurb)" must not blow up or match everything.
  assertEquals(titleMatchesTerm(PATTERN, '3-8'), true);
  assertEquals(titleMatchesTerm('Widget (Refurb) 2-pack', '(refurb)'), true);
  assertEquals(titleMatchesTerm(POKEMON, '.*'), false);
});

// ── Absence is never evidence ──

Deno.test('a missing title never excludes', () => {
  assertEquals(titleMatchesTerm(null, 'pokemon'), false);
  assertEquals(titleMatchesTerm('', 'pokemon'), false);
  assertEquals(findExcludedTitleTerm(null, ['pokemon']), null);
  assertEquals(findExcludedTitleTerm('   ', ['pokemon']), null);
});

Deno.test('an empty term never matches anything', () => {
  assertEquals(titleMatchesTerm(POKEMON, ''), false);
  assertEquals(titleMatchesTerm(POKEMON, '   '), false);
  assertEquals(findExcludedTitleTerm(POKEMON, ['', '  ']), null);
});

// ── findExcludedTitleTerm reports WHICH rule fired ──

Deno.test('returns the matching term so the reason can name it', () => {
  assertEquals(findExcludedTitleTerm(POKEMON, ['refurbished', 'elite trainer box']), 'elite trainer box');
});

Deno.test('returns null when nothing matches', () => {
  assertEquals(findExcludedTitleTerm(KNIFE, ['pokemon', 'refurbished']), null);
});

Deno.test('preserves the ORIGINAL term casing in the reason, not the normalised form', () => {
  assertEquals(findExcludedTitleTerm(POKEMON, ['Elite Trainer Box']), 'Elite Trainer Box');
});

Deno.test('an empty or absent term list excludes nothing', () => {
  assertEquals(findExcludedTitleTerm(POKEMON, []), null);
  assertEquals(findExcludedTitleTerm(POKEMON, null), null);
});

// ── Documented limitation, pinned so a future change is deliberate ──

Deno.test('plurals do NOT match -- predictable over clever', () => {
  assertEquals(titleMatchesTerm('Trading Cards Booster Pack', 'card'), false);
  assertEquals(titleMatchesTerm('Trading Cards Booster Pack', 'cards'), true);
});
