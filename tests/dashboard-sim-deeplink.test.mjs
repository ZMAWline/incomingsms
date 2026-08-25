// Regression tests: ICCID (and SIM #) in the Activation Run item table must
// be clickable and open the existing full SIM detail modal as an overlay on
// top of the operator's current page — the dashboard is a hand-rolled SPA
// (see TAB_ROUTES/switchTab/initTabFromUrl in index.html), and the SIM
// detail modal previously had no way to open outside the Sims tab and could
// only show a SIM already loaded into tableState.sims.data, refusing with a
// toast otherwise. An earlier fix made these links navigate to /sims/:id,
// which switched the active tab away from the Activation Run the operator
// was viewing — that was wrong; this locks in the corrected behavior:
//   1. loadActivationRunItems renders the ICCID (and SIM # when present) as
//      a link that calls openSimDetailModal(sim_id, iccid, tab).
//   2. openSimDetailModal opens the modal WITHOUT switching tabs or changing
//      the URL, so the operator stays on the Activation Run they were
//      viewing underneath the modal.
//   3. openSimDetail falls back to GET /api/sims?id=... when the SIM isn't
//      already in tableState.sims.data (e.g. a fresh page load via deep
//      link, or a SIM outside the operator's current SIMs table filter).
//   4. A direct load of /sims/:id (initTabFromUrl, i.e. page refresh/shared
//      link) still opens the sims tab and the SIM detail modal for that id.

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

async function bootDashboard(fetchRoutes, { pathname = '/', search = '' } = {}) {
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

  const pushCalls = [];
  const sandbox = {
    console,
    document: document_,
    location: { pathname, search, href: 'https://dashboard.test' + pathname + search, reload: () => {} },
    history: {
      pushState: (state, title, url) => { pushCalls.push({ state, url }); sandbox.location.pathname = String(url).split('?')[0]; },
      replaceState: () => {},
      back: () => {},
    },
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

  return { sandbox, elementCache, pushCalls };
}

// index.html declares `tableState`/`currentRunId` with `let`/`const` at
// script top level, so they are NOT reflected as sandbox.* properties (that
// only holds for `function`/`var` declarations) — mutate them by running code
// back through the same vm context instead of assigning on the sandbox object.
function seedTableStateSims(sandbox, sims) {
  vm.runInContext('tableState.sims.data = ' + JSON.stringify(sims) + ';', sandbox);
}

// ---------------------------------------------------------------------
// 1. ICCID / SIM # render as links wired to openSimDetailModal
// ---------------------------------------------------------------------

test('loadActivationRunItems renders the ICCID as a link that opens the linked SIM', async () => {
  const runId = 'run-1';
  const item = { id: 'item-1', iccid: '89012804332468992577', imei: '359729444337382', vendor: 'atomic', status: 'done', sim_id: 5345 };
  const { sandbox, elementCache } = await bootDashboard([
    [`/activation-runs/${runId}`, () => new Response(JSON.stringify({
      run: { id: runId }, items: [item], total_items: 1, carrier_logs: [],
    }), { status: 200 })],
  ]);

  // showActivationRunDetail sets the module-scoped currentRunId as a side
  // effect and itself calls loadActivationRunItems.
  await sandbox.showActivationRunDetail(runId);
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));

  const tbody = elementCache.get('activation-items-tbody');
  assert.ok(tbody.innerHTML.includes('openSimDetailModal(5345'), 'ICCID cell wires up openSimDetailModal with the item\'s sim_id');
  assert.ok(tbody.innerHTML.includes(item.iccid), 'the ICCID text itself is still rendered');
  assert.ok(/>5345</.test(tbody.innerHTML), 'the SIM # cell also renders as a link with the sim_id visible');
});

test('loadActivationRunItems still links the ICCID by iccid alone when sim_id is not yet known (failed item)', async () => {
  const runId = 'run-2';
  const item = { id: 'item-2', iccid: '89012804332469396042', imei: '111', vendor: 'atomic', status: 'failed', error_message: 'ATOMIC port-in failed: Invalid PIN', sim_id: null };
  const { sandbox, elementCache } = await bootDashboard([
    [`/activation-runs/${runId}`, () => new Response(JSON.stringify({
      run: { id: runId }, items: [item], total_items: 1, carrier_logs: [],
    }), { status: 200 })],
  ]);

  await sandbox.showActivationRunDetail(runId);
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));

  const tbody = elementCache.get('activation-items-tbody');
  assert.ok(tbody.innerHTML.includes('openSimDetailModal(null'), 'no sim_id yet, so the link falls back to iccid-only lookup');
  assert.ok(tbody.innerHTML.includes(item.iccid), 'the ICCID is still shown and clickable even without a linked sim_id');
});

// ---------------------------------------------------------------------
// 2. openSimDetailModal opens the modal in place — no tab switch, no URL change
// ---------------------------------------------------------------------

test('openSimDetailModal opens the SIM detail modal from tableState without pushing a URL', async () => {
  const sim = { id: 5345, iccid: '89012804332468992577', msisdn: '9072162205', status: 'active' };
  const { sandbox, elementCache, pushCalls } = await bootDashboard([]);
  seedTableStateSims(sandbox, [sim]);

  sandbox.openSimDetailModal(5345, sim.iccid, 'details');
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));

  assert.equal(pushCalls.length, 0, 'no history entry is pushed — the operator\'s current URL is left untouched');
  const title = elementCache.get('sd-title');
  assert.equal(title.textContent, 'SIM #5345', 'the modal opens for the linked SIM');
  const modal = elementCache.get('sim-detail-modal');
  assert.ok(!modal.classList.contains('hidden'), 'the modal is visible');
});

test('clicking an Activation Run item\'s ICCID opens the SIM detail modal without switching away from the Activation Runs tab', async () => {
  const runId = 'run-3';
  const sim = { id: 5345, iccid: '89012804332468992577', msisdn: '9072162205', status: 'active' };
  const item = { id: 'item-3', iccid: sim.iccid, imei: '359729444337382', vendor: 'atomic', status: 'done', sim_id: sim.id };
  const { sandbox, elementCache, pushCalls } = await bootDashboard([
    [`/activation-runs/${runId}`, () => new Response(JSON.stringify({
      run: { id: runId }, items: [item], total_items: 1, carrier_logs: [],
    }), { status: 200 })],
  ]);
  seedTableStateSims(sandbox, [sim]);

  // Land on the Activation Runs tab and drill into a run's detail, exactly
  // as an operator would before clicking an item's ICCID.
  sandbox.switchTab('activation-runs', false, false);
  await sandbox.showActivationRunDetail(runId);
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  const activationRunsTab = elementCache.get('tab-activation-runs');
  assert.ok(!activationRunsTab.classList.contains('hidden'), 'sanity check: the Activation Runs tab is visible before the click');

  // Spy on switchTab (a bare global reference other top-level functions call
  // unqualified, so reassigning it on the sandbox intercepts those calls too)
  // to directly verify the click handler never asks to change tabs.
  const switchTabCalls = [];
  const originalSwitchTab = sandbox.switchTab;
  sandbox.switchTab = (...callArgs) => { switchTabCalls.push(callArgs); return originalSwitchTab(...callArgs); };

  // Simulate the click: the rendered link calls openSimDetailModal(sim_id, iccid, tab).
  sandbox.openSimDetailModal(item.sim_id, item.iccid, 'details');
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));

  assert.equal(switchTabCalls.length, 0, 'openSimDetailModal must not switch tabs — no redirect to the Sims table');
  assert.ok(!activationRunsTab.classList.contains('hidden'), 'the Activation Runs tab stays visible underneath the modal');
  assert.equal(pushCalls.length, 0, 'no /sims/:id URL is pushed when opened from Activation Runs');

  const modal = elementCache.get('sim-detail-modal');
  assert.ok(!modal.classList.contains('hidden'), 'the SIM detail modal opens on top of the Activation Run page');
  const title = elementCache.get('sd-title');
  assert.equal(title.textContent, 'SIM #5345', 'the modal opens for the SIM linked to the clicked item');
});

// ---------------------------------------------------------------------
// 3. openSimDetail fetch-by-id fallback when not in tableState
// ---------------------------------------------------------------------

test('openSimDetail fetches the SIM by id when it is not already loaded in tableState', async () => {
  const sim = { id: 9999, iccid: '89019999999999999999', msisdn: '2125550199', status: 'active' };
  const { sandbox, elementCache } = await bootDashboard([
    ['/sims?id=9999', () => new Response(JSON.stringify([sim]), { status: 200 })],
  ]);
  seedTableStateSims(sandbox, []); // not loaded

  await sandbox.openSimDetail(9999, 'details');

  const title = elementCache.get('sd-title');
  assert.equal(title.textContent, 'SIM #9999', 'the modal renders using the fetched SIM, not a "not found" error');
  const modal = elementCache.get('sim-detail-modal');
  assert.ok(!modal.classList.contains('hidden'));
});

test('openSimDetail shows an error toast when the SIM cannot be found locally or via fetch', async () => {
  const toasts = [];
  const { sandbox } = await bootDashboard([
    ['/sims?id=424242', () => new Response('[]', { status: 200 })],
  ]);
  seedTableStateSims(sandbox, []);
  sandbox.showToast = (msg, type) => { toasts.push({ msg, type }); };

  await sandbox.openSimDetail(424242, 'details');

  assert.ok(toasts.some(t => t.type === 'error' && /424242/.test(t.msg)), 'an error toast names the SIM that could not be found');
});

// ---------------------------------------------------------------------
// 4. Direct /sims/:id page load opens the modal (bookmarked/shared link)
// ---------------------------------------------------------------------

test('initTabFromUrl opens the SIM detail modal for a direct /sims/:id load', async () => {
  const sim = { id: 5345, iccid: '89012804332468992577', msisdn: '9072162205', status: 'active' };
  const { sandbox, elementCache } = await bootDashboard(
    [['/sims?id=5345', () => new Response(JSON.stringify([sim]), { status: 200 })]],
    { pathname: '/sims/5345' }
  );
  seedTableStateSims(sandbox, []);

  sandbox.initTabFromUrl();
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));

  const simsTab = elementCache.get('tab-sims');
  assert.ok(!simsTab.classList.contains('hidden'), 'the sims tab is shown for a /sims/:id route');
  const title = elementCache.get('sd-title');
  assert.equal(title.textContent, 'SIM #5345', 'the SIM detail modal opens for the id in the URL');
});
