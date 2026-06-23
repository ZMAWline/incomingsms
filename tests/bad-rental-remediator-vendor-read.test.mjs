// INC-16d/16e completion: the worker was passing vendorView=null to the
// classifier, so every report parked in pending_vendor_read / classify_only /
// no_change forever and no remediation ever ran. These tests cover the pure
// projection (vendorViewFromRead) and assert the index.js wiring no longer
// stubs the classifier inputs, and that the per-action cooldown evidence (the
// gate that stops live carrier actions from re-firing every tick) is gathered.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { vendorViewFromRead } from '../src/bad-rental-remediator/vendor.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'bad-rental-remediator', 'index.js'),
  'utf8'
);

// ---- vendorViewFromRead (pure) ----------------------------------------

test('atomic active read → healthy, attStatus passed through', () => {
  const p = vendorViewFromRead('atomic', { ok: true, not_found: false, attStatus: 'active', MSISDN: '+13073845304' });
  assert.equal(p.view.attStatus, 'active');
  assert.equal(p.view.not_found, false);
  assert.equal(p.healthy, true);
  assert.equal(p.extras, null);
});

test('atomic suspended read → not healthy (so A3 restore can route)', () => {
  const p = vendorViewFromRead('atomic', { ok: true, not_found: false, attStatus: 'suspended', MSISDN: null });
  assert.equal(p.view.attStatus, 'suspended');
  assert.equal(p.healthy, false);
});

test('not_found read → view={not_found:true}, not healthy', () => {
  const p = vendorViewFromRead('atomic', { ok: true, not_found: true });
  assert.deepEqual(p.view, { not_found: true });
  assert.equal(p.healthy, false);
});

test('failed read (ok=false) → view null so classifier defers (pending_vendor_read)', () => {
  const p = vendorViewFromRead('atomic', { ok: false, error: 'atomic_http_500' });
  assert.equal(p.view, null);
  assert.equal(p.healthy, false);
});

test('wing activated → healthy, plan + MDN passed through verbatim (case preserved)', () => {
  const p = vendorViewFromRead('wing_iot', {
    ok: true, not_found: false, status: 'activated',
    communicationPlan: 'Wing Tel Inc - NON ABIR SMS MO/MT US', MDN: '+13073845304',
  });
  assert.equal(p.healthy, true);
  assert.equal(p.view.status, 'activated');
  assert.equal(p.view.communicationPlan, 'Wing Tel Inc - NON ABIR SMS MO/MT US');
});

test('helix active → healthy, subscriberNumber passed through', () => {
  const p = vendorViewFromRead('helix', { ok: true, not_found: false, state: 'active', subscriberNumber: '+13073845304', MDN: '+13073845304' });
  assert.equal(p.healthy, true);
  assert.equal(p.view.state, 'active');
  assert.equal(p.view.subscriberNumber, '+13073845304');
});

test('teltik active + port online → healthy + requirePortOnline extras', () => {
  const p = vendorViewFromRead('teltik', { ok: true, not_found: false, line_state: 'active', status: 'active', port_status: 'online', MDN: '3073845304' });
  assert.equal(p.healthy, true);
  assert.deepEqual(p.extras, { requirePortOnline: true, portOnline: true });
});

test('teltik port not online → not healthy (so port reset can route), extras flags offline', () => {
  const p = vendorViewFromRead('teltik', { ok: true, not_found: false, line_state: 'active', status: 'active', port_status: 'offline', MDN: '3073845304' });
  assert.equal(p.healthy, false);
  assert.equal(p.extras.portOnline, false);
});

test('teltik port unknown (read failed → undefined) does NOT look offline-healthy', () => {
  const p = vendorViewFromRead('teltik', { ok: true, not_found: false, line_state: 'active', status: 'active', port_status: undefined, MDN: '3073845304' });
  // healthy requires portOnline; undefined port → not healthy, never triggers a reset as "offline".
  assert.equal(p.healthy, false);
});

// ---- index.js wiring (the bug was these were null/false stubs) ---------

test('classifier call no longer hardcodes vendorView: null', () => {
  assert.ok(!/vendorView:\s*null/.test(SRC), 'vendorView must be wired from the live vendor read, not null');
});

test('classifier call passes the live vendor read view', () => {
  assert.ok(/vendorView,?\n|vendorView\b/.test(SRC) && /readVendorView/.test(SRC),
    'expected readVendorView to feed vendorView');
});

test('recentResellerBadSignal is true (the report IS a fresh bad signal)', () => {
  assert.ok(/recentResellerBadSignal:\s*true/.test(SRC),
    'a fresh reseller report should enable the A1/W3/H3/T3 still-bad remediation branches');
});

test('webhook delivered is sourced from evidence, not hardcoded false', () => {
  assert.ok(!/webhook:\s*\{\s*delivered:\s*false\s*\}/.test(SRC),
    'webhook.delivered must come from evidence.webhook, not a false stub');
});

test('gatherEvidence populates per-action cooldown maps (prevents carrier re-fire spam)', () => {
  assert.ok(/priorActionAttempts\[/.test(SRC), 'expected priorActionAttempts to be populated from attempts');
  assert.ok(/lastActionAttemptAt\[/.test(SRC), 'expected lastActionAttemptAt to be populated from attempts');
  assert.ok(/select=id,action,attempted_at/.test(SRC),
    'attempts query must select action + attempted_at to build the cooldown maps');
});

test('sims select carries helix/ban identifiers needed by vendor read + actions', () => {
  // The sims query select clause is its own string literal; assert on the
  // select= fragment directly rather than the split `sims?...` prefix.
  const sel = SRC.match(/select=id,iccid,vendor,status,msisdn,activated_at,gateway_id,port[^'`"\n]*/);
  assert.ok(sel, 'expected the sims evidence select clause');
  assert.ok(/att_ban/.test(sel[0]), 'sims select must include att_ban for helix_ota');
  assert.ok(/mobility_subscription_id/.test(sel[0]), 'sims select must include mobility_subscription_id for helix read');
  assert.ok(/\bimei\b/.test(sel[0]), 'sims select must include imei');
});
