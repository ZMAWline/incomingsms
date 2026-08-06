// HE1 dashboard visibility: the Bad Rentals view must let an operator ask for
// healthy-evidence auto-resolved reports, and must show the auto-resolution on
// the row itself (badge + reason + resolved-at). Render helpers are extracted
// from the real frontend (src/dashboard/public/index.html) so the test
// exercises shipped code, same technique as dashboard-search-parse.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../src/dashboard/public/index.html', import.meta.url), 'utf8');

function grabFn(name) {
  const s = html.indexOf('function ' + name + '(');
  assert.notEqual(s, -1, name + ' not found in index.html');
  let d = 0, j = s, started = false;
  while (j < html.length) {
    if (html[j] === '{') { d++; started = true; }
    if (html[j] === '}') { if (--d === 0 && started) break; }
    j++;
  }
  return html.slice(s, j + 1);
}

const ctx = vm.createContext({});
vm.runInContext([
  grabFn('escapeHtml'),
  grabFn('badRentalsQueryString'),
  grabFn('badRentalAutoResolutionChip'),
  grabFn('badRentalAutoResolutionDetail'),
].join(';'), ctx);
const { badRentalsQueryString, badRentalAutoResolutionChip, badRentalAutoResolutionDetail } = ctx;

const RESOLVED = 'healthy_evidence_auto_resolved';
const fmtDt = (s) => 'Aug 06 12:30';

const resolvedRow = {
  id: 42,
  status: 'remediated',
  auto_resolution: RESOLVED,
  auto_resolution_reason: 'confirmed_working',
  auto_resolved_at: '2026-08-06T12:30:00Z',
};

test('operator control exists and is wired to the list loader', () => {
  assert.ok(html.includes('id="bad-rentals-healthy-evidence-filter"'), 'auto-resolved toggle present');
  const idx = html.indexOf('id="bad-rentals-healthy-evidence-filter"');
  const tag = html.slice(html.lastIndexOf('<input', idx), html.indexOf('>', idx) + 1);
  assert.match(tag, /type="checkbox"/, 'toggle is a checkbox');
  assert.match(tag, /onchange="loadBadRentals\(\)"/, 'toggle reloads the list');
  assert.ok(html.includes('const heOnly = !!(heSel && heSel.checked)'), 'loadBadRentals reads the toggle');
});

test('auto-resolved view queries by auto_resolution and drops the open-status filter', () => {
  assert.equal(badRentalsQueryString('received,in_triage', true), '?auto_resolution=' + RESOLVED);
  assert.equal(badRentalsQueryString('remediated', true), '?auto_resolution=' + RESOLVED,
    'status never accompanies auto_resolution — auto-resolved rows are already remediated');
  assert.equal(badRentalsQueryString('received,in_triage', false), '?status=received%2Cin_triage');
  assert.equal(badRentalsQueryString('remediated', false), '?status=remediated', 'remediated rows still reachable');
  assert.equal(badRentalsQueryString('', false), '');
});

test('remediated status option and open-report badge stay intact', () => {
  assert.ok(html.includes('<option value="remediated">Remediated</option>'),
    'the auto-resolved control does not replace the Remediated status filter');
  assert.ok(html.includes("const isOpenFilter = filterVal === 'received,in_triage' && !heOnly;"),
    'sidebar open-report badge is not written from the closed-report view');
});

test('row badge renders reason and resolved-at, and only for auto-resolved rows', () => {
  const chip = badRentalAutoResolutionChip(resolvedRow, fmtDt);
  assert.match(chip, /Auto-resolved · healthy evidence/, 'badge label');
  assert.match(chip, /confirmed_working/, 'reason in tooltip');
  assert.match(chip, /Aug 06 12:30/, 'resolved-at in tooltip, formatted');
  assert.equal(badRentalAutoResolutionChip({ id: 1, status: 'remediated' }, fmtDt), '',
    'plain remediated row gets no auto-resolution badge');
  assert.equal(badRentalAutoResolutionChip({ id: 1, auto_resolution: 'something_else' }, fmtDt), '');
  assert.equal(badRentalAutoResolutionChip(null, fmtDt), '');
});

test('badge falls back to the HE1 reason when the API omits it', () => {
  const chip = badRentalAutoResolutionChip({ id: 7, auto_resolution: RESOLVED }, fmtDt);
  assert.match(chip, /confirmed_working/, 'default reason');
  assert.match(chip, /resolved at unknown/, 'missing timestamp is stated, not silently dropped');
});

test('auto-assessment sub-row spells out the auto-resolution', () => {
  const detail = badRentalAutoResolutionDetail(resolvedRow, fmtDt);
  assert.match(detail, /auto-resolved: confirmed_working/);
  assert.match(detail, /Aug 06 12:30/);
  assert.equal(badRentalAutoResolutionDetail({ id: 1, status: 'received' }, fmtDt), '');
});

test('badge is rendered in the status cell and the sub-row', () => {
  assert.ok(html.includes("statusBadge + badRentalAutoResolutionChip(r, fmtDt)"),
    'status cell shows the badge in every view, not just the auto-resolved one');
  assert.ok(html.includes('badRentalAutoResolutionDetail(r, fmtDt)'), 'sub-row detail wired');
  assert.ok(html.includes("'auto-resolved on healthy evidence'"), 'raw outcome gets a human label');
});

test('compact summary chip is present and fed by the HE1 summary endpoint', () => {
  assert.ok(html.includes('id="bad-rentals-healthy-evidence-summary"'), 'summary chip element');
  assert.ok(html.includes("/bad-rentals/healthy-evidence-summary?days=7"), 'summary endpoint called');
  assert.ok(html.includes('loadHealthyEvidenceSummary();'), 'summary refreshed with the list');
});
