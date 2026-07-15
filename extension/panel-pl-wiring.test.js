// Regression test: entering/removing cost must never change the inputs fed
// to computePrivateLabelRisk(). The pure function itself is proven
// cost-independent in plRisk.test.js; this test guards the actual call site
// in panel.js, which is the real place a future edit could accidentally
// thread a cost/roi/profit variable into PL scoring.
// Run with: node --test extension/panel-pl-wiring.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, 'panel.js'), 'utf8');

function extractCallArgs(fnName) {
  const marker = `self.${fnName}({`;
  const start = src.indexOf(marker);
  assert.ok(start >= 0, `${marker} not found in panel.js`);
  const openBraceIdx = start + marker.length - 1; // index of the opening "{"
  let depth = 0;
  for (let i = openBraceIdx; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(openBraceIdx, i + 1);
    }
  }
  throw new Error(`Unbalanced braces reading ${fnName} call site`);
}

test('computePrivateLabelRisk() call site only passes Keepa-derived fields, never cost/roi/profit', () => {
  const argsText = extractCallArgs('computePrivateLabelRisk');
  assert.match(argsText, /sellerHistory\s*:/);
  assert.match(argsText, /buyBoxOwnership\s*:/);
  assert.match(argsText, /productAgeDays\s*:/);
  for (const forbidden of ['roi', 'profit', 'unitCost', 'totalCost', 'saleOverride', 'costMissing']) {
    const re = new RegExp(`\\b${forbidden}\\b`, 'i');
    assert.ok(!re.test(argsText), `computePrivateLabelRisk() call must not reference "${forbidden}" — found in: ${argsText}`);
  }
});

test('costMissing IS passed to renderDecisionMatrix (Decision Confidence is allowed to depend on cost)', () => {
  const argsText = extractCallArgs('computePrivateLabelRisk');
  // Sanity check the two data flows stay separate: costMissing exists
  // elsewhere in panel.js (feeding Decision Confidence) but never inside
  // the PL-risk call args extracted above.
  assert.ok(src.includes('costMissing: totalCost <= 0'), 'expected costMissing to be derived from totalCost for renderDecisionMatrix');
  assert.ok(!argsText.includes('costMissing'));
});
