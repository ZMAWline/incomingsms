// INC-25 followup regression: rental and sim evidence queries must not
// reference columns that don't exist (caused HTTP 400 to be swallowed and
// reports closed as false-duplicate). Also covers the S7 stale-context
// classifier added to prevent vendor remediation against historical rentals.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyStaleContext,
  normalizeE164,
} from '../src/bad-rental-remediator/stale-classifier.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'bad-rental-remediator', 'index.js'),
  'utf8'
);

const NONEXISTENT_RENTAL_COLUMNS = ['started_at', 'ended_at'];
const NONEXISTENT_SIM_COLUMNS    = ['deactivated_at', 'retired_at', 'current_mdn_e164'];

test('rentals?* queries do not select or filter on nonexistent columns', () => {
  const qs = SRC.match(/rentals\?[^'`"\n]+/g) || [];
  assert.ok(qs.length > 0, 'expected at least one rentals query');
  for (const q of qs) {
    for (const col of NONEXISTENT_RENTAL_COLUMNS) {
      assert.ok(!q.includes(col), `rentals query references nonexistent column "${col}": ${q}`);
    }
  }
});

test('sims?* queries do not select or filter on nonexistent columns', () => {
  const qs = SRC.match(/sims\?[^'`"\n]+/g) || [];
  assert.ok(qs.length > 0, 'expected at least one sims query');
  for (const q of qs) {
    for (const col of NONEXISTENT_SIM_COLUMNS) {
      assert.ok(!q.includes(col), `sims query references nonexistent column "${col}": ${q}`);
    }
  }
});

test('gatherEvidence records simLookupError on non-ok sims GET', () => {
  assert.ok(/simLookupError\s*=\s*\{[\s\S]*http_status/.test(SRC),
    'expected gatherEvidence to record sim lookup http_status');
});

test('gatherEvidence loads sim_number context (historical + current)', () => {
  const queries = SRC.match(/sim_numbers\?[^'`"\n]+/g) || [];
  assert.ok(queries.length >= 2,
    'expected at least two sim_numbers queries (sim_number_id + current by sim_id)');
  assert.ok(SRC.includes('valid_to=is.null'),
    'expected a current sim_number lookup filtered by valid_to is.null');
});

test('classifyShared delegates to classifyStaleContext before S4/S6', () => {
  assert.ok(SRC.includes("import('./stale-classifier.mjs')"),
    'expected classifyShared to import stale-classifier');
  assert.ok(SRC.includes('classifyStaleContext({ report, evidence })'),
    'expected classifyShared to invoke classifyStaleContext');
});

// ----- pure logic tests for stale-classifier ----------------------------

test('normalizeE164: national 10-digit US → +1XXXXXXXXXX', () => {
  assert.equal(normalizeE164('3073845304'), '+13073845304');
  assert.equal(normalizeE164('13073845304'), '+13073845304');
  assert.equal(normalizeE164('+13073845304'), '+13073845304');
  assert.equal(normalizeE164(null), null);
  assert.equal(normalizeE164(''), null);
});

test('S7a old_rental_not_current: historical sim_number, e164 mismatch → close duplicate, no vendor action', () => {
  const v = classifyStaleContext({
    report:   { id: 1, e164: '+17402025814', rental_id: 10, sim_id: 1041, sim_number_id: 59542 },
    evidence: {
      sim: { id: 1041, vendor: 'atomic', current_mdn_e164: '+13073845304' },
      rental: { id: 10 },
      simNumber: { id: 59542, e164: '+17402025814', valid_to: '2026-05-29T05:20:01Z', isHistorical: true },
      currentSimNumberE164: '+13073845304',
    },
  });
  assert.ok(v, 'expected a verdict');
  assert.equal(v.mode, 'S7a');
  assert.equal(v.action, 'close_duplicate');
  assert.equal(v.outcome, 'duplicate');
  assert.equal(v.evidenceSummary.reason, 'old_rental_not_current');
});

test('S7b stale_intake_mapping: historical sim_number, report.e164 == current MDN → escalate, no vendor action', () => {
  const v = classifyStaleContext({
    report:   { id: 134, e164: '+13073845304', rental_id: 36775, sim_id: 1041, sim_number_id: 59542 },
    evidence: {
      sim: { id: 1041, vendor: 'atomic', current_mdn_e164: '+13073845304' },
      rental: { id: 36775 },
      simNumber: { id: 59542, e164: '+17402025814', valid_to: '2026-05-29T05:20:01Z', isHistorical: true },
      currentSimNumberE164: '+13073845304',
    },
  });
  assert.ok(v);
  assert.equal(v.mode, 'S7b');
  assert.equal(v.action, 'escalate');
  assert.equal(v.outcome, 'escalate');
  assert.equal(v.escalationReason, 'stale_intake_mapping');
  assert.equal(v.evidenceSummary.reason, 'stale_intake_mapping');
});

test('rentalLookupError → escalate evidence_lookup_failed (rental), never duplicate', () => {
  const v = classifyStaleContext({
    report:   { id: 1, e164: '+13073845304', rental_id: 36775, sim_id: 1041 },
    evidence: { rentalLookupError: { http_status: 400, body: 'column rentals.started_at does not exist' } },
  });
  assert.ok(v);
  assert.equal(v.action, 'escalate');
  assert.equal(v.escalationReason, 'evidence_lookup_failed');
  assert.equal(v.evidenceSummary.lookup, 'rental');
});

test('simLookupError → escalate evidence_lookup_failed (sim), never duplicate', () => {
  const v = classifyStaleContext({
    report:   { id: 1, e164: '+13073845304', sim_id: 1041 },
    evidence: { simLookupError: { http_status: 400, body: 'column sims.deactivated_at does not exist' } },
  });
  assert.ok(v);
  assert.equal(v.action, 'escalate');
  assert.equal(v.escalationReason, 'evidence_lookup_failed');
  assert.equal(v.evidenceSummary.lookup, 'sim');
});

test('valid current-MDN report (non-historical sim_number) → null, falls through to vendor classifier', () => {
  const v = classifyStaleContext({
    report:   { id: 5, e164: '+13073845304', rental_id: 36775, sim_id: 1041, sim_number_id: 99999 },
    evidence: {
      sim: { id: 1041, vendor: 'atomic', current_mdn_e164: '+13073845304' },
      rental: { id: 36775 },
      simNumber: { id: 99999, e164: '+13073845304', valid_to: null, isHistorical: false },
      currentSimNumberE164: '+13073845304',
    },
  });
  assert.equal(v, null);
});

test('no sim_number context → null (falls through to S4 no_rental_row when rental is also missing, S6 otherwise)', () => {
  const v = classifyStaleContext({
    report:   { id: 6, e164: '+13073845304', rental_id: 7777, sim_id: 1041 },
    evidence: {
      sim: { id: 1041, vendor: 'atomic', current_mdn_e164: '+13073845304' },
      rental: { id: 7777 },
    },
  });
  assert.equal(v, null);
});
