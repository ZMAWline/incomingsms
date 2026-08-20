// otp-portal pure-logic tests — candidate selection, message scoping, and
// the constant-time token compare. No network, no DB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeToE164,
  vendorToCarrier,
  constantTimeEqual,
  computeAvailableCandidates,
  pickRandom,
  filterAssignmentMessages,
  escapeHtml,
  highlightOtpHtml,
} from '../src/otp-portal/logic.mjs';

test('constantTimeEqual only true for exact matches', () => {
  assert.equal(constantTimeEqual('abc123', 'abc123'), true);
  assert.equal(constantTimeEqual('abc123', 'abc124'), false);
  assert.equal(constantTimeEqual('abc123', 'abc12'), false);
  assert.equal(constantTimeEqual('', ''), true);
  assert.equal(constantTimeEqual(null, ''), true);
  assert.equal(constantTimeEqual(undefined, 'x'), false);
});

test('vendorToCarrier: teltik is T-Mobile, everything else AT&T', () => {
  assert.equal(vendorToCarrier('teltik'), 'T-Mobile');
  assert.equal(vendorToCarrier('atomic'), 'AT&T');
  assert.equal(vendorToCarrier(undefined), 'AT&T');
});

test('computeAvailableCandidates excludes sims rented by a paying storefront customer', () => {
  const out = computeAvailableCandidates({
    sims: [{ id: 1, vendor: 'atomic' }, { id: 2, vendor: 'teltik' }],
    numbers: [{ sim_id: 1, e164: '+13475551111' }, { sim_id: 2, e164: '+13475552222' }],
    activeShopRentals: [{ sim_id: 1 }],
    activeAssignments: [],
  });
  assert.deepEqual(out.map((c) => c.sim_id), [2]);
});

test('computeAvailableCandidates excludes sims already held by another otp-portal session', () => {
  const out = computeAvailableCandidates({
    sims: [{ id: 1, vendor: 'atomic' }, { id: 2, vendor: 'teltik' }],
    numbers: [{ sim_id: 1, e164: '+13475551111' }, { sim_id: 2, e164: '+13475552222' }],
    activeShopRentals: [],
    activeAssignments: [{ sim_id: 2 }],
  });
  assert.deepEqual(out.map((c) => c.sim_id), [1]);
});

test('computeAvailableCandidates excludes sims with no current number', () => {
  const out = computeAvailableCandidates({
    sims: [{ id: 1, vendor: 'atomic' }],
    numbers: [], // no current sim_numbers row
    activeShopRentals: [],
    activeAssignments: [],
  });
  assert.deepEqual(out, []);
});

test('computeAvailableCandidates normalizes e164 on the way out', () => {
  const out = computeAvailableCandidates({
    sims: [{ id: 1, vendor: 'atomic' }],
    numbers: [{ sim_id: 1, e164: '3475551111' }],
    activeShopRentals: [],
    activeAssignments: [],
  });
  assert.equal(out[0].e164, '+13475551111');
});

test('pickRandom is deterministic with an injected RNG and picks from the full range', () => {
  const candidates = [{ sim_id: 1 }, { sim_id: 2 }, { sim_id: 3 }];
  assert.equal(pickRandom(candidates, () => 0).sim_id, 1);
  assert.equal(pickRandom(candidates, () => 0.34).sim_id, 2);
  assert.equal(pickRandom(candidates, () => 0.99999).sim_id, 3);
  assert.equal(pickRandom([], () => 0), null);
});

test('filterAssignmentMessages: only the assigned number, only after assignment time', () => {
  const assignedAtMs = Date.parse('2026-08-19T12:00:00Z');
  const messages = [
    // before assignment — must be excluded even though it's the right number
    { to_number: '+13475551111', from_number: 'Google', body: 'code 123456', received_at: '2026-08-19T11:59:00Z' },
    // exact boundary — inclusive
    { to_number: '+13475551111', from_number: 'Google', body: 'code 222222', received_at: '2026-08-19T12:00:00Z' },
    // after assignment, right number — included
    { to_number: '3475551111', from_number: 'Google', body: 'code 333333', received_at: '2026-08-19T12:05:00Z' },
    // after assignment, wrong number (sim was rotated in between somehow) — excluded
    { to_number: '+13475559999', from_number: 'Google', body: 'code 444444', received_at: '2026-08-19T12:06:00Z' },
  ];
  const out = filterAssignmentMessages(messages, { e164: '+13475551111', assignedAtMs });
  assert.deepEqual(out.map((m) => m.body), ['code 222222', 'code 333333']);
  // shape is limited to display fields only — no raw/internal columns leak through
  assert.deepEqual(Object.keys(out[0]).sort(), ['body', 'from_number', 'received_at']);
});

test('highlightOtpHtml escapes the body and wraps 4-8 digit runs', () => {
  assert.equal(highlightOtpHtml('Your code is 123456 <script>'),
    'Your code is <mark>123456</mark> &lt;script&gt;');
  assert.equal(escapeHtml('<b>&"\'</b>'), '&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;');
});
