// sim-canceller and sim-status-changer tell the reseller about operator
// actions with the only two reseller events: cancel and suspend send
// number.offline, restore sends number.online. Before this test the POST
// helper used an `env` it never received, so no webhook was ever sent, and
// sim-canceller looked the reseller up only after closing the assignment.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import canceller from '../src/sim-canceller/index.js';
import statusChanger from '../src/sim-status-changer/index.js';

const WEBHOOK = 'https://reseller.example/hook';
const ATOMIC = 'https://atomic.example';

const realSetTimeout = globalThis.setTimeout;
beforeEach(() => {
  // Both workers sleep 2s between SIMs; skip that wait, keep real timers.
  globalThis.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, ms === 2000 ? 0 : ms, ...a);
});
afterEach(() => { globalThis.setTimeout = realSetTimeout; });

function json(body, status = 200) {
  return { ok: status < 300, status, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) };
}

// Minimal PostgREST + ATOMIC + reseller-webhook stub. `reseller` null means
// the SIM has no active reseller.
function stub({ sim, reseller = 'r1', webhookStatus = 200 }) {
  const state = { assignmentActive: true, numberOpen: true, webhooks: [] };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || 'GET';
    if (u === WEBHOOK) {
      state.webhooks.push(JSON.parse(init.body));
      return json({ rentalId: 1 }, webhookStatus);
    }
    if (u === ATOMIC) return json({ wholeSaleApi: { wholeSaleResponse: { statusCode: '00' } } });
    const [table, qs = ''] = u.split('/rest/v1/')[1].split('?');
    if (method === 'GET' && table === 'sims') return json([sim]);
    if (method === 'GET' && table === 'reseller_sims') {
      return json(reseller && state.assignmentActive && qs.includes('active=eq.true') ? [{ reseller_id: reseller }] : []);
    }
    if (method === 'GET' && table === 'reseller_webhooks') return json([{ url: WEBHOOK }]);
    if (method === 'GET' && table === 'sim_numbers') return json(state.numberOpen ? [{ e164: '+13025550100' }] : []);
    if (method === 'PATCH' && table === 'reseller_sims') state.assignmentActive = false;
    if (method === 'PATCH' && table === 'sim_numbers') state.numberOpen = false;
    return json([]);
  };
  return state;
}

const env = {
  SUPABASE_URL: 'https://sb.example',
  SUPABASE_SERVICE_ROLE_KEY: 'k',
  CANCEL_SECRET: 'c',
  STATUS_SECRET: 's',
  ATOMIC_API_URL: ATOMIC,
};

const atomicSim = { id: 42, iccid: '8901', mobility_subscription_id: null, msisdn: '3025550100', vendor: 'atomic' };

function cancel(iccid) {
  return canceller.fetch(new Request('https://w/cancel?secret=c', { method: 'POST', body: JSON.stringify({ iccids: [iccid] }) }), env);
}
function changeStatus(action, simId) {
  return statusChanger.fetch(new Request(`https://w/${action}?secret=s`, { method: 'POST', body: JSON.stringify({ sim_ids: [simId] }) }), env);
}

test('cancel sends exactly one number.offline to the reseller webhook', async () => {
  const state = stub({ sim: { ...atomicSim, status: 'active' } });
  const body = await (await cancel('8901')).json();
  assert.equal(body.results[0].cancelled, true);
  assert.equal(state.webhooks.length, 1);
  const [p] = state.webhooks;
  assert.equal(p.event_type, 'number.offline');
  assert.match(p.message_id, /^number\.offline_[0-9a-f]{16}$/);
  assert.deepEqual(p.data, {
    sim_id: 42, iccid: '8901', number: '+13025550100', online: false,
    mobilitySubscriptionId: null, reason: 'canceled', carrier: 'att', verified: true,
  });
});

test('restore sends exactly one number.online', async () => {
  const state = stub({ sim: { ...atomicSim, status: 'suspended' } });
  const body = await (await changeStatus('restore', 42)).json();
  assert.equal(body.results[0].ok, true);
  assert.equal(state.webhooks.length, 1);
  assert.equal(state.webhooks[0].event_type, 'number.online');
  assert.equal(state.webhooks[0].data.online, true);
  assert.equal(state.webhooks[0].data.reason, 'restored');
  assert.equal(state.webhooks[0].data.number, '+13025550100');
});

test('suspend sends number.offline (a suspended line is offline)', async () => {
  const state = stub({ sim: { ...atomicSim, status: 'active' } });
  await changeStatus('suspend', 42);
  assert.equal(state.webhooks.length, 1);
  assert.equal(state.webhooks[0].event_type, 'number.offline');
  assert.equal(state.webhooks[0].data.reason, 'suspended');
});

test('no webhook when the SIM has no reseller', async () => {
  const a = stub({ sim: { ...atomicSim, status: 'active' }, reseller: null });
  assert.equal((await (await cancel('8901')).json()).results[0].cancelled, true);
  assert.equal(a.webhooks.length, 0);
  const b = stub({ sim: { ...atomicSim, status: 'suspended' }, reseller: null });
  assert.equal((await (await changeStatus('restore', 42)).json()).results[0].ok, true);
  assert.equal(b.webhooks.length, 0);
});

test('a webhook 500 does not fail the cancel or the restore', async () => {
  const a = stub({ sim: { ...atomicSim, status: 'active' }, webhookStatus: 500 });
  const c = await (await cancel('8901')).json();
  assert.equal(c.results[0].cancelled, true);
  assert.equal(c.errors, 0);
  assert.equal(a.webhooks.length, 1);
  const b = stub({ sim: { ...atomicSim, status: 'suspended' }, webhookStatus: 500 });
  const r = await (await changeStatus('restore', 42)).json();
  assert.equal(r.results[0].ok, true);
  assert.equal(b.webhooks.length, 1);
});
