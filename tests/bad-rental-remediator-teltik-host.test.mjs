import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { executeAction } from '../src/bad-rental-remediator/actions.mjs';
import { isTeltikHosted, isSkylineHosted } from '../src/shared/gateway-host.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REMEDIATOR_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'bad-rental-remediator', 'index.js'),
  'utf8'
);
const VENDOR_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'bad-rental-remediator', 'vendor.mjs'),
  'utf8'
);
const DASHBOARD_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'dashboard', 'index.js'),
  'utf8'
);
const DASHBOARD_HTML = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'dashboard', 'public', 'index.html'),
  'utf8'
);

test('Teltik-hosted Atomic SIMs are included by gateway_host, non-Teltik hosts excluded', () => {
  assert.equal(isTeltikHosted({ vendor: 'atomic', gateway_host: 'teltik' }), true);
  assert.equal(isSkylineHosted({ vendor: 'atomic', gateway_host: 'skyline' }), true);
  assert.equal(isTeltikHosted({ vendor: 'atomic', gateway_host: 'skyline' }), false);
});

test('remediator gathers gateway_host and routes TH5 before vendor-only classifier', () => {
  assert.match(REMEDIATOR_SRC, /select=id,iccid,vendor,gateway_host,status,msisdn/);
  assert.match(REMEDIATOR_SRC, /isTeltikHosted\(evidence\.sim\)/);
  assert.match(REMEDIATOR_SRC, /nonTerminal\('TH5', 'teltik_reset_port'/);
  assert.match(REMEDIATOR_SRC, /issue_type:\s*ISSUE_TELTIK_GATEWAY_PORT_OFFLINE/);
});

test('TH5 reset uses Teltik-known MDN (fallback current SIM MDN), never reported rental e164 or ICCID', () => {
  assert.match(REMEDIATOR_SRC, /ctx\.mdn = \(evidence\.teltikKnownMdn && evidence\.teltikKnownMdn\.mdn\)\n\s*\|\| \(evidence\.sim && evidence\.sim\.current_mdn_e164\) \|\| null/);
  assert.match(REMEDIATOR_SRC, /reset_mdn10:\s*mdn10\(resetMdn\)/);
  assert.doesNotMatch(REMEDIATOR_SRC, /ctx\.mdn\s*=\s*report\.e164/);
  assert.doesNotMatch(REMEDIATOR_SRC, /teltikResetPort\([^)]*iccid/);
});

test('remediator resolves the Teltik-known MDN from latest Teltik inbound SMS', () => {
  // Same shared rule the dashboard host-check uses (40feedb): prefer the
  // latest Teltik-delivered inbound SMS destination over the DB current MDN.
  assert.match(REMEDIATOR_SRC, /pickTeltikKnownMdn\(latestTeltikSms, evidence\.sim\.current_mdn_e164\)/);
  assert.match(REMEDIATOR_SRC, /latestTeltikSmsQuery\(evidence\.sim\.id\)/);
  // The vendor read is keyed by it too (teltik get-info).
  assert.match(REMEDIATOR_SRC, /teltikKnownMdn: evidence\.teltikKnownMdn && evidence\.teltikKnownMdn\.mdn \|\| null/);
});

test('remediator Teltik /v1/port-status is never called with an mdn param', () => {
  const psLines = VENDOR_SRC.split('\n');
  const idx = psLines.findIndex(l => l.includes('api.smsgateway.xyz/v1/port-status'));
  assert.ok(idx >= 0, 'expected port-status call in remediator vendor.mjs');
  // The URL is built across the following concatenation lines — none may add mdn.
  const urlBlock = psLines.slice(idx, idx + 3).join('\n');
  assert.doesNotMatch(urlBlock, /mdn/i, 'port-status must take only apikey: ' + urlBlock.trim());
  // The host probe no longer gates on the SIM having a current MDN.
  assert.match(REMEDIATOR_SRC, /isTeltikHosted\(evidence\.sim\)\) \{\n\s*try \{\n\s*evidence\.teltikHostPortStatus = await teltikPortStatus\(env\);/);
});

test('teltik vendor read keys get-info by the Teltik-known MDN and port-status by apikey only', async () => {
  const { readVendorView } = await import('../src/bad-rental-remediator/vendor.mjs');
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/v1/get-info')) {
      return new Response(JSON.stringify({ iccid: '8901X', gateway_id: 'GW-1', port: '3' }), { status: 200 });
    }
    return new Response(JSON.stringify({ success: true, status: 'Registered' }), { status: 200 });
  };
  try {
    const res = await readVendorView(
      { TELTIK_API_KEY: 'test-key' },
      { id: 9, vendor: 'teltik', iccid: '8901OLD', current_mdn_e164: '+19995550000' },
      { teltikKnownMdn: '+13075550101' },
    );
    assert.equal(res.ok, true);
    const getInfo = calls.find(u => u.includes('/v1/get-info'));
    assert.match(getInfo, /mdn=3075550101/, 'get-info must use the Teltik-known MDN');
    assert.doesNotMatch(getInfo, /9995550000/, 'get-info must not use the stale DB MDN when a Teltik-known MDN exists');
    const portStatus = calls.find(u => u.includes('/v1/port-status'));
    assert.ok(portStatus, 'expected a port-status probe');
    assert.doesNotMatch(portStatus, /mdn/i, 'port-status takes apikey only');
    // Teltik never attests an MDN — view.MDN must be null so T8 cannot sync
    // the stale Teltik-known MDN over the DB current one.
    assert.equal(res.view.MDN, null);
    assert.equal(res.view.iccid, '8901X');
  } finally {
    globalThis.fetch = orig;
  }
});

test('teltik_reset_port executor normalizes +1 current MDN to 10-digit reset key', async () => {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ ok: true, request_id: 'req-1' }), { status: 200 });
  };
  try {
    const res = await executeAction({
      TELTIK_API_KEY: 'test-key',
      REMEDIATOR_KV: { async get() { return null; }, async put() {} },
    }, {
      action: 'teltik_reset_port',
      sim: { id: 7, current_mdn_e164: '+13073845304', iccid: '8901SHOULDNOTUSE' },
      report: { id: 55, e164: '+19998887777' },
      attemptNo: 1,
    });
    assert.equal(res.ok, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /\/v1\/reset-port\?/);
    assert.match(calls[0], /mdn=3073845304/);
    assert.doesNotMatch(calls[0], /9998887777/);
    assert.doesNotMatch(calls[0], /8901SHOULDNOTUSE/);
  } finally {
    globalThis.fetch = orig;
  }
});

test('dashboard exposes issue-type filter, sort button, and Teltik offline CSV export', () => {
  assert.match(DASHBOARD_SRC, /handleTeltikPortOfflineExport/);
  assert.match(DASHBOARD_SRC, /escalation_reason=eq\.|teltik_gateway_port_offline/);
  assert.match(DASHBOARD_SRC, /current_mdn.*iccid.*gateway_host.*service_provider/s);
  assert.match(DASHBOARD_HTML, /bad-rentals-issue-filter/);
  assert.match(DASHBOARD_HTML, /sortBadRentalsByIssue/);
  assert.match(DASHBOARD_HTML, /downloadTeltikPortOfflineExport/);
});
