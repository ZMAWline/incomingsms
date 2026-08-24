// Regression tests for a live user report on dashboard-test.zalmen-531.workers.dev:
// the Activation Runs UI truncated errors so badly (CSS max-w+truncate on the
// item row, and no rendering at all of the run-level `error` column) that the
// real reason a run/item failed was never actually visible to an operator.
//
// This locks in three fixes:
//   1. A run-level error banner (`#ar-detail-error-banner`) now renders the
//      full, untruncated `run.error` text (e.g. the "Validation errors: ..."
//      message set when every row in a submission fails validation and no
//      job items are ever created — total_items stays 0).
//   2. Per-item errors are still visually clipped in the compact table cell,
//      but clicking the cell now opens `#error-detail-modal` with the full,
//      untruncated `item.error_message` text (see the real 406036eb /
//      b11b2839 / a48b19eb runs from dashboard-test — b11b2839's item error
//      was a long PostgREST RPC-not-found message that used to be readable
//      only via a hover tooltip).
//   3. Neither code path ever calls `.slice(`/`.substring(` on the error text
//      itself (CSS-only clipping is fine; string truncation would silently
//      drop the actionable part of a long error).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML_PATH = path.join(__dirname, '..', 'src', 'dashboard', 'public', 'index.html');
const HTML = fs.readFileSync(HTML_PATH, 'utf8');

function extractAllInlineScripts(html) {
  const re = /<script>([\s\S]*?)<\/script>/g;
  let js = '';
  let m;
  while ((m = re.exec(html))) js += m[1] + '\n;\n';
  return js.replace('__HELIX_ENABLED__', 'false');
}

const FRONTEND_JS = extractAllInlineScripts(HTML);

function makeClassList() {
  const set = new Set();
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
    disabled: false,
    style: {},
    classList: makeClassList(),
    dataset: {},
    children: [],
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

  async function fetchMock(url) {
    const u = String(url);
    for (const [pattern, handler] of fetchRoutes) {
      if (u.includes(pattern)) return handler(u);
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

  vm.runInContext(FRONTEND_JS, sandbox, { filename: 'dashboard-inline-script.js' });
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));

  return { sandbox, elementCache };
}

const LONG_RUN_ERROR = 'Validation errors: ' + Array.from({ length: 10 }, (_, i) => `row ${i + 1}: iccid must be 19-20 digits`).join('; ');
const LONG_ITEM_ERROR = 'Error: pickNextPpuAddress: RPC HTTP 404: {"code":"PGRST202","details":"Searched for the function public.claim_address_pool_entry with parameters p_exclude_state, p_exclude_zip or with a single unnamed json/jsonb parameter, but no matches were found in the schema cache.","hint":null,"message":"Could not find the function public.claim_address_pool_entry(p_exclude_state, p_exclude_zip) in the schema cache"}';

test('run-level error banner renders the full, untruncated run.error text', async () => {
  const runId = '406036eb-4df0-4a1f-9f88-68a74c174919';
  const { sandbox, elementCache } = await bootDashboard([
    [`/api/activation-runs/${runId}`, () => new Response(JSON.stringify({
      run: { id: runId, status: 'failed', source: 'json', total_items: 0, done_items: 0, failed_items: 0, retry_needed_items: 0, error: LONG_RUN_ERROR },
      items: [], total_items: 0, carrier_logs: [],
    }), { status: 200 })],
  ]);

  await sandbox.showActivationRunDetail(runId);
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));

  const banner = elementCache.get('ar-detail-error-banner');
  const bannerText = elementCache.get('ar-detail-error-text');

  assert.ok(banner.classList.contains('hidden') === false, 'error banner must be shown when run.error is set');
  assert.equal(bannerText.textContent, LONG_RUN_ERROR, 'the full run.error text must be rendered, not a truncated/sliced version');
});

test('run-level error banner stays hidden when run.error is null', async () => {
  const runId = 'b11b2839-69aa-4b94-8d81-07c1b99fb113';
  const { sandbox, elementCache } = await bootDashboard([
    [`/api/activation-runs/${runId}`, () => new Response(JSON.stringify({
      run: { id: runId, status: 'failed', source: 'json', total_items: 1, done_items: 0, failed_items: 1, retry_needed_items: 0, error: null },
      items: [{ id: 'item-1', iccid: '89012804332468992577', imei: '359729444337382', vendor: 'atomic', status: 'failed', attempt: 1, max_attempts: 3, error_message: LONG_ITEM_ERROR, sim_id: null }],
      total_items: 1, carrier_logs: [],
    }), { status: 200 })],
  ]);

  await sandbox.showActivationRunDetail(runId);
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));

  const banner = elementCache.get('ar-detail-error-banner');
  assert.ok(banner.classList.contains('hidden'), 'error banner must stay hidden when the run itself has no run-level error');

  const tbody = elementCache.get('activation-items-tbody');
  assert.ok(tbody.innerHTML.includes('showErrorDetailModal'), 'the failed item row must wire up the full-error modal');
  assert.ok(tbody.innerHTML.includes('claim_address_pool_entry'), 'the full item error_message must be embedded for the modal, not truncated before render');
});

test('showErrorDetailModal renders the full, untruncated error text and un-hides the modal', async () => {
  const { sandbox, elementCache } = await bootDashboard([]);

  sandbox.showErrorDetailModal(LONG_ITEM_ERROR);

  const modal = elementCache.get('error-detail-modal');
  const modalText = elementCache.get('error-detail-modal-text');
  assert.ok(modal.classList.contains('hidden') === false, 'modal must be shown');
  assert.equal(modalText.textContent, LONG_ITEM_ERROR, 'the modal must display the full error text');
});

test('neither the run-level banner nor the item error cell truncates the error text via string slicing', () => {
  const detailStart = HTML.indexOf('async function showActivationRunDetail(');
  const itemsStart = HTML.indexOf('async function loadActivationRunItems(');
  const itemsEnd = HTML.indexOf('function activationItemsPrevPage(');
  assert.notEqual(detailStart, -1);
  assert.notEqual(itemsStart, -1);
  assert.notEqual(itemsEnd, -1);

  const detailSrc = HTML.slice(detailStart, itemsStart);
  const itemsSrc = HTML.slice(itemsStart, itemsEnd);

  assert.ok(!/run\.error[^;]*\.(slice|substring)\(/.test(detailSrc), 'run.error must not be string-truncated before rendering');
  assert.ok(!/item\.error_message[^;]*\.(slice|substring)\(/.test(itemsSrc), 'item.error_message must not be string-truncated before rendering');
});
