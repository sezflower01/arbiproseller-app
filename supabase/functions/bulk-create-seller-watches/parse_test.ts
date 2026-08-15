// Tests for bulk seller-watch input parsing.
//
// Imports the REAL module rather than mirroring it (the workaround used by
// check-price-alerts, whose index.ts calls Deno.serve at module scope). This
// logic decides which rows land in a user's watchlist, so a drifting copy
// would be worse than no test.
//
// Run:
//   deno test --allow-net --allow-env --allow-read \
//     supabase/functions/bulk-create-seller-watches/parse_test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { classifyInput, parseSellerLine, splitInputLines } from './parse.ts';

Deno.test('parseSellerLine: bare seller ID', () => {
  assertEquals(parseSellerLine('A1B0EBOAJDDILW'), 'A1B0EBOAJDDILW');
});

Deno.test('parseSellerLine: normalises case', () => {
  assertEquals(parseSellerLine('a1b0eboajddilw'), 'A1B0EBOAJDDILW');
});

Deno.test('parseSellerLine: full storefront URL', () => {
  const url = 'https://www.amazon.com/sp?ie=UTF8&seller=A1B0EBOAJDDILW&me=A1B0EBOAJDDILW';
  assertEquals(parseSellerLine(url), 'A1B0EBOAJDDILW');
});

Deno.test('parseSellerLine: URL me= wins over other long alphanumeric runs', () => {
  // marketplaceID is a valid-looking token and appears BEFORE me= here. If
  // the column scan ran first it would return the wrong ID entirely.
  const url = 'https://www.amazon.com/sp?marketplaceID=ATVPDKIKX0DER&me=A221MUUT57POIV&ref_=sr';
  assertEquals(parseSellerLine(url), 'A221MUUT57POIV');
});

Deno.test('parseSellerLine: CSV with ID first', () => {
  assertEquals(parseSellerLine('A1B0EBOAJDDILW,Pedu'), 'A1B0EBOAJDDILW');
});

Deno.test('parseSellerLine: CSV with name first', () => {
  assertEquals(parseSellerLine('Pedu,A1B0EBOAJDDILW'), 'A1B0EBOAJDDILW');
});

Deno.test('parseSellerLine: strips surrounding quotes', () => {
  assertEquals(parseSellerLine('"A1B0EBOAJDDILW","Pedu"'), 'A1B0EBOAJDDILW');
});

Deno.test('parseSellerLine: semicolon and tab delimiters', () => {
  assertEquals(parseSellerLine('Pedu;A1B0EBOAJDDILW'), 'A1B0EBOAJDDILW');
  assertEquals(parseSellerLine('Pedu\tA1B0EBOAJDDILW'), 'A1B0EBOAJDDILW');
});

Deno.test('parseSellerLine: rejects too-short and too-long tokens', () => {
  assertEquals(parseSellerLine('ABC12'), null);            // 5 chars
  assertEquals(parseSellerLine('A'.repeat(21)), null);     // 21 chars
});

Deno.test('parseSellerLine: rejects lines with nothing ID-shaped', () => {
  assertEquals(parseSellerLine('not a seller'), null);
  assertEquals(parseSellerLine(''), null);
  assertEquals(parseSellerLine('   '), null);
});

Deno.test('splitInputLines: drops a header row', () => {
  const text = 'seller_id,name\nA1B0EBOAJDDILW,Pedu\nA221MUUT57POIV,VIP';
  assertEquals(splitInputLines(text).length, 2);
});

Deno.test('splitInputLines: keeps a first line that IS an ID', () => {
  const text = 'A1B0EBOAJDDILW\nA221MUUT57POIV';
  assertEquals(splitInputLines(text), ['A1B0EBOAJDDILW', 'A221MUUT57POIV']);
});

Deno.test('splitInputLines: single ID line is not mistaken for a header', () => {
  assertEquals(splitInputLines('A1B0EBOAJDDILW'), ['A1B0EBOAJDDILW']);
});

Deno.test('splitInputLines: handles CRLF and blank lines', () => {
  const text = 'A1B0EBOAJDDILW\r\n\r\nA221MUUT57POIV\r\n';
  assertEquals(splitInputLines(text), ['A1B0EBOAJDDILW', 'A221MUUT57POIV']);
});

Deno.test('classifyInput: dedupes case-insensitively, preserving first-seen order', () => {
  const { parsed, duplicates } = classifyInput('A1B0EBOAJDDILW\na1b0eboajddilw\nA221MUUT57POIV');
  assertEquals(parsed, ['A1B0EBOAJDDILW', 'A221MUUT57POIV']);
  assertEquals(duplicates, ['A1B0EBOAJDDILW']);
});

Deno.test('classifyInput: separates invalid lines from valid ones', () => {
  const { parsed, invalid } = classifyInput('A1B0EBOAJDDILW\ngarbage line\nA221MUUT57POIV');
  assertEquals(parsed.length, 2);
  assertEquals(invalid, ['garbage line']);
});

Deno.test('classifyInput: mixed bare IDs, URLs and CSV rows in one paste', () => {
  const text = [
    'seller_id,note',
    'A1B0EBOAJDDILW,first',
    'https://www.amazon.com/sp?me=A221MUUT57POIV',
    'Some Store;A1JGL3QS3PG2RX',
    'oops',
  ].join('\n');
  const { parsed, invalid } = classifyInput(text);
  assertEquals(parsed, ['A1B0EBOAJDDILW', 'A221MUUT57POIV', 'A1JGL3QS3PG2RX']);
  assertEquals(invalid, ['oops']);
});

Deno.test('classifyInput: caps the reject samples it echoes back', () => {
  const text = Array.from({ length: 120 }, (_, i) => `bad line ${i}`).join('\n');
  const { invalid, parsed } = classifyInput(text, 50);
  assertEquals(parsed.length, 0);
  assertEquals(invalid.length, 50);
});

Deno.test('classifyInput: empty input yields nothing rather than throwing', () => {
  const { parsed, invalid, duplicates } = classifyInput('');
  assertEquals(parsed.length, 0);
  assertEquals(invalid.length, 0);
  assertEquals(duplicates.length, 0);
});
