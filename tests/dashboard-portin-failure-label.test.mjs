// Behavioural test for the SIMs-table port-in failure badge.
//
// Pulls the real labelling code out of public/index.html and runs it, rather
// than asserting that certain text appears in the source. The fixtures are the
// four distinct carrier responses actually present in PROD on 2026-09-08
// (`select distinct atomic_portin_status_code, atomic_portin_description from
// sims where atomic_portin_status_code <> '00'`), so a change that breaks the
// mapping fails here instead of in front of an operator.

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const HTML = readFileSync('src/dashboard/public/index.html', 'utf8');

function loadLabeller() {
  const start = HTML.indexOf('const PORTIN_REASON_LABELS');
  assert.notEqual(start, -1, 'PORTIN_REASON_LABELS not found — did the badge code move?');
  const marker = 'function portInFailureLabel(s) {';
  const fnStart = HTML.indexOf(marker, start);
  assert.notEqual(fnStart, -1, 'portInFailureLabel not found');
  // Brace-count to the end of the function so the slice stays valid JS.
  let depth = 0, i = fnStart + marker.length - 1, started = false;
  while (i < HTML.length) {
    const c = HTML[i];
    if (c === '{') { depth++; started = true; }
    if (c === '}') { if (--depth === 0 && started) break; }
    i++;
  }
  const src = HTML.slice(start, i + 1);
  const ctx = vm.createContext({});
  vm.runInContext(src + '\nthis.portInFailureLabel = portInFailureLabel;', ctx);
  return ctx.portInFailureLabel;
}

const REAL_PROD_RESPONSES = [
  {
    name: '948, 38 SIMs',
    sim: { atomic_portin_status_code: '948', atomic_portin_description: 'Error!!Port Request Does Not Exist' },
    expected: 'No Request',
  },
  {
    name: '948 alternate wording, 1 SIM',
    sim: { atomic_portin_status_code: '948', atomic_portin_description: 'portRequestInfo Does Not Exist' },
    expected: 'No Request',
  },
  {
    name: '951 / 8A, 11 SIMs',
    sim: {
      atomic_portin_status_code: '951',
      atomic_portin_description: 'Portin status fail.Conflict ~ statusReasonCode - 8A ~ statusReasonDescription - Account number required or incorrect',
    },
    expected: 'Wrong Account',
  },
  {
    name: '951 / 6B, 3 SIMs',
    sim: {
      atomic_portin_status_code: '951',
      atomic_portin_description: 'Portin status fail.Conflict ~ statusReasonCode - 6B ~ statusReasonDescription - T-Mobile Number Transfer PIN is required or incorrect',
    },
    expected: 'Wrong PIN',
  },
];

for (const { name, sim, expected } of REAL_PROD_RESPONSES) {
  test(`port-in badge labels ${name} as "${expected}"`, () => {
    assert.equal(loadLabeller()(sim), expected);
  });
}

test('statusReasonCode wins over the top-level code', () => {
  // Both 8A and 6B arrive under 951. Labelling by code alone would collapse
  // them into one useless label, which is the bug this mapping exists to avoid.
  const label = loadLabeller();
  const byReason = REAL_PROD_RESPONSES.filter(r => r.sim.atomic_portin_status_code === '951')
    .map(r => label(r.sim));
  assert.equal(new Set(byReason).size, 2, '951 must not collapse to a single label');
});

test('an unrecognised response shows the raw code rather than a wrong label', () => {
  const label = loadLabeller();
  assert.equal(label({ atomic_portin_status_code: '777', atomic_portin_description: 'brand new failure' }), 'Port-in 777');
  assert.equal(label({ atomic_portin_status_code: '951', atomic_portin_description: 'no reason code here' }), 'Rejected');
});

test('a completed port-in is not treated as a failure', () => {
  const start = HTML.indexOf('function simPortInFailed(s) {');
  assert.notEqual(start, -1);
  const ctx = vm.createContext({});
  vm.runInContext(HTML.slice(start, HTML.indexOf('\n        }', start) + 10) + '\nthis.f = simPortInFailed;', ctx);
  assert.equal(ctx.f({ atomic_portin_status_code: '00' }), false);
  assert.equal(ctx.f({ atomic_portin_status_code: null }), false);
  assert.equal(ctx.f({ atomic_portin_status_code: '951' }), true);
});
