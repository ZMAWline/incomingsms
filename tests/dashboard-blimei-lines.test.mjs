import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const dashboardWorker = readFileSync(new URL('../src/dashboard/index.js', import.meta.url), 'utf8');
const dashboardHtml = readFileSync(new URL('../src/dashboard/public/index.html', import.meta.url), 'utf8');

function extractFn(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, 'not found: ' + signature);
  let depth = 0;
  let started = false;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    const c = source[i];
    if (c === '{') { depth++; started = true; }
    if (c === '}') {
      depth--;
      if (started && depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('unterminated: ' + signature);
}

test('/api/sims reads sims.imei and returns it as blimei', async () => {
  let capturedQuery = '';
  const sandbox = {
    Response,
    URL,
    console,
    async supabaseGetAllArray(_env, query) {
      capturedQuery = query;
      return [{
        id: 7,
        iccid: '89014103271234567890',
        imei: '353490123456789',
        status: 'active',
        vendor: 'atomic',
        sim_numbers: [{ e164: '+15551234567', verification_status: 'verified' }],
        reseller_sims: [{ reseller_id: 12, resellers: { name: 'Test Reseller' } }],
        gateways: { code: 'GW1', name: 'Gateway 1' },
      }];
    },
    async fetch() {
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFn(dashboardWorker, 'async function handleSims(env, corsHeaders, url) {'), sandbox);

  const res = await sandbox.handleSims(
    { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'srv' },
    {},
    new URL('https://dashboard.test/api/sims')
  );
  const rows = await res.json();

  assert.match(capturedQuery, /sims\?select=id,iccid,imei,msisdn,/, 'the query must read the existing sims.imei field');
  assert.equal(rows[0].blimei, '353490123456789', 'the API must expose sims.imei as blimei');
});

test('SIMs table renders a visible sortable BLIMEI column', () => {
  assert.match(
    dashboardHtml,
    /sortTable\('sims','blimei'\)\">BLIMEI <span class="sort-arrow" data-table="sims" data-col="blimei"><\/span>/,
    'the SIMs table header must show a visible BLIMEI column'
  );
  assert.match(
    dashboardHtml,
    /\$\{sim\.blimei \|\| '-'\}/,
    'the SIMs table row must render the BLIMEI value'
  );
  assert.match(
    dashboardHtml,
    /blimei: 'BLIMEI'/,
    'the column visibility menu must include BLIMEI'
  );
});

test('SIMs export and detail surfaces include BLIMEI', () => {
  assert.match(
    dashboardHtml,
    /'ID','Gateway','Port','ICCID','Phone','BLIMEI','Verification'/,
    'the SIMs CSV export header must include BLIMEI'
  );
  assert.match(
    dashboardHtml,
    /esc\(s\.blimei \|\| ''\)/,
    'the SIMs CSV export rows must include BLIMEI values'
  );
  assert.match(
    dashboardHtml,
    /_sdField\('BLIMEI', '<span class="font-mono text-xs">' \+ \(sim\.blimei \|\| ''\) \+ '<\/span>'\)/,
    'the SIM detail drawer must show BLIMEI'
  );
});
