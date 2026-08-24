// Regression tests for the port-in "default random subscriber info" +
// "reseller dropdown applies to every row" UI work: by default a port-in
// line needs no manual name/address entry (server auto-fills a random
// identity per row — see activation-bulk.test.mjs), the "Use custom
// subscriber info" toggle is off/hidden by default and only reveals the
// manual fields when checked, and a single "activate to reseller" dropdown
// is sent once and applied to every submitted row instead of requiring a
// reseller_id column in every pasted/CSV row.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML_PATH = path.join(__dirname, '..', 'src', 'dashboard', 'public', 'index.html');
const HTML = fs.readFileSync(HTML_PATH, 'utf8');

// ---------------------------------------------------------------------
// 1. Static markup checks — cheap, no DOM/vm simulation needed.
// ---------------------------------------------------------------------

test('markup: custom subscriber-info fields are hidden by default', () => {
  const idx = HTML.indexOf('id="activate-port-custom-fields"');
  assert.notEqual(idx, -1, 'activate-port-custom-fields container not found');
  const tagStart = HTML.lastIndexOf('<div', idx);
  const tagEnd = HTML.indexOf('>', idx);
  const openTag = HTML.slice(tagStart, tagEnd + 1);
  assert.match(openTag, /class="hidden/, 'custom subscriber-info fields must start hidden');
});

test('markup: custom-info toggle checkbox has no checked attribute (unchecked by default)', () => {
  const idx = HTML.indexOf('id="activate-port-custom-info"');
  assert.notEqual(idx, -1, 'activate-port-custom-info checkbox not found');
  const tagStart = HTML.lastIndexOf('<input', idx);
  const tagEnd = HTML.indexOf('>', idx);
  const openTag = HTML.slice(tagStart, tagEnd + 1);
  assert.doesNotMatch(openTag, /\bchecked\b/, 'custom-info toggle must be unchecked by default');
});

test('markup: a reseller dropdown select exists in the Activate modal', () => {
  assert.match(HTML, /<select id="activate-reseller-select"/);
});

test('markup: the standalone port-in reseller ID text box has been removed (superseded by the dropdown)', () => {
  assert.doesNotMatch(HTML, /id="activate-port-reseller-id"/);
});

// ---------------------------------------------------------------------
// 2. Full boot simulation — same harness pattern as
//    dashboard-activation-runs-boot-render.test.mjs.
// ---------------------------------------------------------------------

function extractAllInlineScripts(html) {
  const re = /<script>([\s\S]*?)<\/script>/g;
  let js = '';
  let m;
  while ((m = re.exec(html))) js += m[1] + '\n;\n';
  return js.replace('__HELIX_ENABLED__', 'false');
}

const FRONTEND_JS = extractAllInlineScripts(HTML);

function makeClassList(initial) {
  const set = new Set(initial || []);
  return {
    add: (...c) => c.forEach((x) => set.add(x)),
    remove: (...c) => c.forEach((x) => set.delete(x)),
    contains: (c) => set.has(c),
    toggle: (c, force) => {
      if (force === undefined) (set.has(c) ? set.delete(c) : set.add(c));
      else if (force) set.add(c);
      else set.delete(c);
    },
  };
}

function makeElement(id) {
  return {
    id,
    innerHTML: '',
    textContent: '',
    value: '',
    checked: false,
    disabled: false,
    style: {},
    classList: makeClassList(id === 'activate-port-custom-fields' || id === 'activate-port-fields' ? ['hidden'] : []),
    dataset: {},
    children: [],
    files: [],
    addEventListener: () => {},
    removeEventListener: () => {},
    appendChild: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
    getAttribute: () => null,
    setAttribute: () => {},
    focus: () => {},
    select: () => {},
    click: () => {},
    remove: () => {},
    closest: () => null,
  };
}

async function bootDashboard(fetchRoutes) {
  const elementCache = new Map();
  const getElementById = (id) => {
    if (!elementCache.has(id)) elementCache.set(id, makeElement(id));
    return elementCache.get(id);
  };
  const document_ = {
    getElementById,
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
    createElement: (tag) => makeElement('__created_' + tag),
    title: '',
    body: makeElement('body'),
    documentElement: makeElement('html'),
  };
  const localStorageStore = new Map();
  const localStorage_ = {
    getItem: (k) => (localStorageStore.has(k) ? localStorageStore.get(k) : null),
    setItem: (k, v) => localStorageStore.set(k, String(v)),
    removeItem: (k) => localStorageStore.delete(k),
  };

  const fetchCalls = [];
  async function fetchMock(url, opts) {
    fetchCalls.push({ url: String(url), opts });
    for (const [pattern, handler] of (fetchRoutes || [])) {
      if (String(url).includes(pattern)) return handler(url, opts);
    }
    return new Response('[]', { status: 200 });
  }

  const sandbox = {
    console,
    document: document_,
    location: { pathname: '/', search: '', href: 'https://dashboard.test/', reload: () => {} },
    history: { pushState: () => {}, replaceState: () => {}, back: () => {} },
    localStorage: localStorage_,
    fetch: fetchMock,
    Response, URL, URLSearchParams, AbortController, Request,
    setTimeout: (fn, ms, ...args) => setTimeout(fn, Math.min(ms || 0, 5), ...args),
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    Date, Set, Map, JSON, Math,
    navigator: { clipboard: { writeText: async () => {} } },
    Chart: function Chart() {},
    tailwind: { config: {} },
    addEventListener: () => {},
    onerror: null,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);

  let syncThrow = null;
  try {
    vm.runInContext(FRONTEND_JS, sandbox, { filename: 'dashboard-inline-script.js' });
  } catch (e) {
    syncThrow = e;
  }
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));

  return { sandbox, elementCache, fetchCalls, syncThrow };
}

test('boot: script loads without throwing', async () => {
  const { syncThrow } = await bootDashboard([]);
  assert.equal(syncThrow, null, syncThrow && syncThrow.stack);
});

test('showActivateModal populates the reseller dropdown from the cached reseller list', async () => {
  const { sandbox, elementCache } = await bootDashboard([]);
  sandbox.window._simsResellersCache = [{ id: 1, name: 'Acme Wireless' }, { id: 2, name: 'Beta Mobile' }];
  sandbox.showActivateModal();
  const sel = sandbox.document.getElementById('activate-reseller-select');
  assert.match(sel.innerHTML, /Acme Wireless/);
  assert.match(sel.innerHTML, /Beta Mobile/);
});

test('updateActivatePortCustomInfoUi: unchecked hides the custom fields, checked reveals them', async () => {
  const { sandbox, elementCache } = await bootDashboard([]);
  const toggle = sandbox.document.getElementById('activate-port-custom-info');
  const fields = sandbox.document.getElementById('activate-port-custom-fields');

  toggle.checked = false;
  sandbox.updateActivatePortCustomInfoUi();
  assert.equal(fields.classList.contains('hidden'), true, 'fields must stay hidden when toggle is off');

  toggle.checked = true;
  sandbox.updateActivatePortCustomInfoUi();
  assert.equal(fields.classList.contains('hidden'), false, 'fields must be revealed when toggle is on');

  toggle.checked = false;
  sandbox.updateActivatePortCustomInfoUi();
  assert.equal(fields.classList.contains('hidden'), true, 'fields must hide again when toggle is switched back off');
});

test('activateSims: dropdown reseller_id is sent once at the top level and applied to a row with no reseller_id column', async () => {
  const { sandbox, elementCache, fetchCalls } = await bootDashboard([
    ['/activate', () => new Response(JSON.stringify({ queued: 1, validation_errors: 0 }), { status: 200 })],
  ]);
  sandbox.showConfirm = async () => true;

  sandbox.document.getElementById('activate-vendor').value = 'atomic';
  sandbox.document.getElementById('activate-reseller-select').value = '4';
  sandbox.document.getElementById('activate-input').value = '89014103271467425631 123456789012345';
  sandbox.document.getElementById('activate-csv-file').files = [];

  await sandbox.activateSims();

  const call = fetchCalls.find((c) => c.url.includes('/activate'));
  assert.ok(call, '/activate was called');
  const body = JSON.parse(call.opts.body);
  assert.equal(body.reseller_id, '4', 'the dropdown value is forwarded at the top level');
  assert.equal(body.sims.length, 1);
  assert.equal(body.sims[0].reseller_id, 4, 'the row itself also carries the resolved reseller_id');
  assert.equal(body.sims[0].iccid, '89014103271467425631');
  assert.equal(body.sims[0].imei, '123456789012345');
});

test('activateSims: bulk port-in paste with the custom-info toggle off sends multiple rows with blank name/address fields', async () => {
  const { sandbox, elementCache, fetchCalls } = await bootDashboard([
    ['/activate', () => new Response(JSON.stringify({ queued: 2, validation_errors: 0 }), { status: 200 })],
  ]);
  sandbox.showConfirm = async () => true;

  sandbox.document.getElementById('activate-vendor').value = 'atomic';
  sandbox.document.getElementById('activate-reseller-select').value = '4';
  sandbox.document.getElementById('activate-port-in').checked = true;
  sandbox.document.getElementById('activate-port-custom-info').checked = false;
  sandbox.document.getElementById('activate-csv-file').files = [];
  sandbox.document.getElementById('activate-input').value = [
    '89014103271467425631 123456789012345 2125550101 ACCT1 1111',
    '89014103271467425632 123456789012346 2125550102 ACCT2 2222',
  ].join('\n');

  await sandbox.activateSims();

  const call = fetchCalls.find((c) => c.url.includes('/activate'));
  assert.ok(call, '/activate was called for a multi-row port-in paste — the old one-row cap is gone');
  const body = JSON.parse(call.opts.body);
  assert.equal(body.sims.length, 2);
  for (const sim of body.sims) {
    assert.equal(sim.port_in, true);
    assert.equal(sim.port_first_name, '', 'name fields stay blank client-side — server fills random info per row');
    assert.equal(sim.reseller_id, 4);
  }
  assert.equal(body.sims[0].port_mdn, '2125550101');
  assert.equal(body.sims[1].port_mdn, '2125550102');
  assert.equal(body.sims[0].port_account_number, 'ACCT1');
  assert.equal(body.sims[1].port_account_number, 'ACCT2');
});
