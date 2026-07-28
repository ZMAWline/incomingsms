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

test('TH5 reset uses current SIM MDN, not reported rental e164 or ICCID', () => {
  assert.match(REMEDIATOR_SRC, /ctx\.mdn = \(evidence\.sim && evidence\.sim\.current_mdn_e164\) \|\| null/);
  assert.match(REMEDIATOR_SRC, /current_mdn10:\s*mdn10\(evidence\.sim\.current_mdn_e164/);
  assert.doesNotMatch(REMEDIATOR_SRC, /ctx\.mdn\s*=\s*report\.e164/);
  assert.doesNotMatch(REMEDIATOR_SRC, /teltikResetPort\([^)]*iccid/);
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


test('SIM Query uses service provider API and adds Teltik port-status for hosted SIMs', () => {
  assert.match(DASHBOARD_SRC, /gateway_host:\s*sim\.gateway_host/);
  assert.match(DASHBOARD_SRC, /handleTeltikPortStatusQuery/);
  assert.match(DASHBOARD_SRC, /\/api\/teltik-port-status/);
  assert.match(DASHBOARD_SRC, /get-info\?apikey=.*mdn=/s);
  assert.match(DASHBOARD_SRC, /port-status\?apikey=/);
  assert.match(DASHBOARD_HTML, /fetchHostedTeltikPortStatus/);
  assert.match(DASHBOARD_HTML, /_teltikHostPortTag\(sim, atomicMdn \|\| sim\.phone_number\)/);
  assert.match(DASHBOARD_HTML, /\[Teltik port=/);
});
