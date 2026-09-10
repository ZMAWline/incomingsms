// The SIMs table's Gateway column shows the physical gateway host, never the
// carrier.
//
// gateway_host is 'skyline' or 'teltik' — the hardware the card is seated in.
// vendor is the carrier account (teltik = T-Mobile, atomic/helix/wing_iot =
// AT&T). The column used to render a "T-Mobile" badge for any SIM whose vendor
// was teltik, which put a carrier name in a gateway column and, because it
// keyed off vendor, would have mislabeled an AT&T SIM seated in a Teltik
// gateway. See src/shared/gateway-host.mjs.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = fs.readFileSync(path.join(__dirname, '../src/dashboard/public/index.html'), 'utf8');

function gatewayHostOf() {
  const start = HTML.indexOf('function gatewayHostOf(sim) {');
  assert.notEqual(start, -1, 'frontend gatewayHostOf not found');
  const end = HTML.indexOf('\n        }', start) + '\n        }'.length;
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(HTML.slice(start, end), sandbox);
  return sandbox.gatewayHostOf;
}

test('the frontend host resolver matches the shared module', () => {
  const host = gatewayHostOf();
  assert.equal(host({ gateway_host: 'skyline' }), 'skyline');
  assert.equal(host({ gateway_host: 'teltik' }), 'teltik');
  // An explicit host always wins over the carrier account. An AT&T SIM seated
  // in a Teltik gateway is teltik-hosted.
  assert.equal(host({ gateway_host: 'teltik', vendor: 'atomic' }), 'teltik');
  assert.equal(host({ gateway_host: 'skyline', vendor: 'teltik' }), 'skyline');
  // Missing/garbage falls back to teltik, not to something derived from vendor.
  assert.equal(host({ vendor: 'atomic' }), 'teltik');
  assert.equal(host({ vendor: 'teltik' }), 'teltik');
  assert.equal(host({ gateway_host: 'nonsense' }), 'teltik');
  assert.equal(host({}), 'teltik');
  assert.equal(host(null), 'teltik');
});

test('the Gateway column renders the host, and never the carrier', () => {
  const start = HTML.indexOf('const simHost = gatewayHostOf(sim);');
  assert.notEqual(start, -1, 'gateway cell must resolve the host');
  const cell = HTML.slice(start, HTML.indexOf('const statusClass', start));

  assert.match(cell, /simHost === 'skyline'/, 'must branch on the host');
  assert.ok(!/sim\.vendor/.test(cell), 'the gateway cell must not read sim.vendor');
  assert.ok(!/T-Mobile/.test(cell), 'a carrier name must not appear in the gateway column');
  assert.match(cell, />Teltik</, 'teltik-hosted SIMs are labelled Teltik');
  assert.match(cell, /sim\.gateway_code/, 'skyline-hosted SIMs show their gateway code');
});

test('a SkyLine-hosted SIM with no gateway is shown as inconsistent, not blank', () => {
  const start = HTML.indexOf('const simHost = gatewayHostOf(sim);');
  const cell = HTML.slice(start, HTML.indexOf('const statusClass', start));
  assert.match(cell, /unassigned/i, 'skyline host with no gateway_code must be called out');
});

test('isTeltikHostedSim no longer derives the host from vendor', () => {
  const start = HTML.indexOf('function isTeltikHostedSim(sim) {');
  const body = HTML.slice(start, HTML.indexOf('\n        }', start));
  assert.ok(!/sim\.vendor/.test(body), 'must not fall back to vendor');
  assert.match(body, /gatewayHostOf\(sim\)/, 'must use the shared resolver');
});
