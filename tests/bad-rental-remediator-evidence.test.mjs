// INC-25 followup regression: rental evidence query must not reference columns
// that don't exist on `rentals` (caused HTTP 400 to be swallowed and report
// closed as false-duplicate "no_rental_row"). Also asserts the source contains
// the escalation branch for lookup failures rather than dropping straight into
// the no_rental_row terminal.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'bad-rental-remediator', 'index.js'),
  'utf8'
);

const NONEXISTENT_RENTAL_COLUMNS = ['started_at', 'ended_at'];

test('rentals?* queries do not select or filter on nonexistent columns', () => {
  const rentalQueries = SRC.match(/rentals\?[^'`"\n]+/g) || [];
  assert.ok(rentalQueries.length > 0, 'expected at least one rentals query');
  for (const q of rentalQueries) {
    for (const col of NONEXISTENT_RENTAL_COLUMNS) {
      assert.ok(
        !q.includes(col),
        `rentals query references nonexistent column "${col}": ${q}`
      );
    }
  }
});

test('classifyShared distinguishes rental lookup failure from no_rental_row', () => {
  assert.ok(
    SRC.includes("'evidence_lookup_failed'"),
    'expected an evidence_lookup_failed escalation branch'
  );
  assert.ok(
    SRC.includes('rentalLookupError'),
    'expected evidence to carry rentalLookupError flag'
  );
});

test('gatherEvidence records rentalLookupError on non-ok rentals GET', () => {
  assert.ok(
    /rentalLookupError\s*=\s*\{[\s\S]*http_status/.test(SRC),
    'expected gatherEvidence to record http_status when rental lookup fails'
  );
});
