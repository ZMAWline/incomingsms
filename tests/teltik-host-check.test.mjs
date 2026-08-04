import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pickTeltikKnownMdn, latestTeltikSmsQuery } from '../src/shared/teltik-known-mdn.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'dashboard', 'index.js'),
  'utf8'
);
const DASHBOARD_HTML = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'dashboard', 'public', 'index.html'),
  'utf8'
);
const DETAILS_FINALIZER_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'details-finalizer', 'index.js'),
  'utf8'
);

test('latest raw Teltik inbound SMS payload MDN is preferred over DB/current/canonical MDNs', () => {
  const picked = pickTeltikKnownMdn(
    {
      to_number: '+199****0000', // canonical DB/current number; not a Teltik API key
      raw: { destination: '19175550101' },
      received_at: '2026-07-27T00:00:00Z',
    },
    '+199****0000'
  );
  assert.equal(picked.mdn, '19175550101');
  assert.equal(picked.source, 'teltik_inbound_sms_payload_mdn');
  assert.equal(picked.received_at, '2026-07-27T00:00:00Z');
});

test('DB current MDN is only a fallback when no Teltik inbound SMS exists', () => {
  const picked = pickTeltikKnownMdn(null, 'DB_CURRENT_MDN');
  assert.equal(picked.mdn, 'DB_CURRENT_MDN');
  assert.equal(picked.source, 'db_current_mdn');
  // A row without a raw payload destination cannot be used either — to_number
  // may be our canonical DB number and must not become the Teltik API key.
  const fromEmptyRow = pickTeltikKnownMdn({ to_number: 'CANONICAL_TO_NUMBER', raw: {} }, 'DB_CURRENT_MDN');
  assert.equal(fromEmptyRow.mdn, 'DB_CURRENT_MDN');
  assert.equal(fromEmptyRow.source, 'db_current_mdn');
  assert.equal(pickTeltikKnownMdn(null, null), null);
});

test('latest-SMS lookup targets Teltik-delivered rows for the SIM, newest first', () => {
  const q = latestTeltikSmsQuery(42);
  assert.match(q, /^inbound_sms\?/);
  assert.match(q, /sim_id=eq\.42/);
  // Teltik webhook rows are the ones without a physical port.
  assert.match(q, /port=is\.null/);
  assert.match(q, /select=to_number,received_at,raw/);
  assert.match(q, /raw=not\.is\.null/);
  assert.match(q, /order=received_at\.desc/);
  assert.match(q, /limit=1/);
});

test('SIM Query picks the provider API by sims.vendor', () => {
  // Bulk dispatch map: vendor decides the main carrier endpoint.
  assert.match(DASHBOARD_HTML, /v === 'wing_iot' \? '\/wing-check'/);
  assert.match(DASHBOARD_HTML, /v === 'teltik' \? '\/teltik-query'/);
  assert.match(DASHBOARD_HTML, /v === 'atomic' \? '\/atomic-query' : '\/helix-query'/);
});

test('single-SIM query keeps the full-detail modal, not a collapsed status line', () => {
  assert.match(DASHBOARD_HTML, /if \(selected\.length === 1\)/);
  assert.match(DASHBOARD_HTML, /querySimCarrier\(simId, sim\.vendor \|\| 'unknown'/);
  // Atomic/Wing modal branches still dump the full provider response.
  assert.match(DASHBOARD_HTML, /--- Full Response ---/);
  assert.match(DASHBOARD_HTML, /attStatus/);
});

test('Teltik-hosted non-Teltik SIM query appends Teltik host checks', () => {
  assert.match(DASHBOARD_SRC, /\/api\/teltik-host-check/);
  assert.match(DASHBOARD_SRC, /handleTeltikHostCheck/);
  // Frontend needs gateway_host to know a SIM is Teltik-hosted.
  assert.match(DASHBOARD_SRC, /gateway_host:\s*sim\.gateway_host/);
  assert.match(DASHBOARD_HTML, /isTeltikHostedNonTeltik/);
  // Single-SIM modal appends the detailed block; bulk lines get the tag.
  assert.match(DASHBOARD_HTML, /teltikHostDetailsBlock\(currentCarrierQuerySim\)/);
  assert.match(DASHBOARD_HTML, /_teltikHostTag\(sim\)/);
});
test('Teltik /v1/port-status carries MDN and never ICCID; get-info carries MDN too', () => {
  assert.match(DASHBOARD_SRC, /v1\/port-status\?apikey=' \+ encodeURIComponent\(apiKey\)\n\s*\+ '&mdn=' \+ encodeURIComponent\(portStatusMdn\)/);
  assert.match(DASHBOARD_SRC, /v1\/port-status\?apikey=' \+ encodeURIComponent\(apiKey\) \+ '&mdn=' \+ encodeURIComponent\(mdnDigits\)/);
  assert.doesNotMatch(DASHBOARD_SRC, /port-status\?[^\n]+iccid/i, 'port-status must never be keyed by ICCID');
  assert.match(DASHBOARD_SRC, /no valid Teltik-known MDN — port-status skipped/);
  // Line-specific Teltik context comes from get-info by the Teltik-known MDN.
  assert.match(DASHBOARD_SRC, /get-info\?apikey=' \+ encodeURIComponent\(apiKey\) \+ '&mdn=/);
});

test('host check reports which MDN source was used', () => {
  assert.match(DASHBOARD_SRC, /mdn_source/);
  assert.match(DASHBOARD_SRC, /latest_teltik_sms/);
  assert.match(DASHBOARD_HTML, /teltikHostMdnSourceLabel/);
  assert.match(DASHBOARD_HTML, /Teltik-known MDN/);
});

test('dashboard manual Teltik reset and ICCID heal use shared Teltik-known payload-MDN resolver', () => {
  assert.match(DASHBOARD_SRC, /resolveTeltikKnownMdnForSim/);
  assert.match(DASHBOARD_SRC, /latestTeltikSmsQuery\(sim\.id\)/);
  assert.match(DASHBOARD_SRC, /resolveTeltikKnownMdnForSim\(env, \{ id: sim_id, iccid: row\.iccid \}/);
  assert.match(DASHBOARD_SRC, /const picked = await resolveTeltikKnownMdnForSim/);
  assert.doesNotMatch(DASHBOARD_SRC, /Resolve MDN: prefer DB/);
  assert.doesNotMatch(DASHBOARD_SRC, /mdnSource = 'teltik_live'/);
});

test('details-finalizer Teltik sync_iccid uses shared Teltik-known payload-MDN resolver', () => {
  assert.match(DETAILS_FINALIZER_SRC, /pickTeltikKnownMdn, latestTeltikSmsQuery/);
  assert.match(DETAILS_FINALIZER_SRC, /resolveTeltikKnownMdnForFinalizer/);
  assert.match(DETAILS_FINALIZER_SRC, /latestTeltikSmsQuery\(sim\.id\)/);
  assert.match(DETAILS_FINALIZER_SRC, /const pickedMdn = await resolveTeltikKnownMdnForFinalizer\(env, sim\)/);
  assert.doesNotMatch(DETAILS_FINALIZER_SRC, /const mdn = `1\$\{sim\.msisdn\}`/);
});
