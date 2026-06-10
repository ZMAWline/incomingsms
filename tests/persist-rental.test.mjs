// Tests for src/shared/persist-rental.mjs — number.online → rentals upsert.
//
// Background (2026-06-10): bad-rental reports 135–139 escalated as
// intake_unresolved_current_mdn_no_rental even though webhook_deliveries proved
// the reseller already returned a fresh rentalId. The rentals table was last
// written on 2026-05-29 (a batch backfill); the live workers never persisted
// the rentalId echoed back on every number.online delivery. These tests pin the
// contract that the shared helper extracts the rentalId, maps the payload to a
// rentals upsert body, and is idempotent on (reseller_id, sim_number_id).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseRentalIdFromResponse,
  buildRentalUpsertBody,
  persistRentalFromWebhookResponse,
} from '../src/shared/persist-rental.mjs';

// ----------------------------------------------------------------------------
// parseRentalIdFromResponse — accepts TrustOTP-shape JSON and loose variants
// ----------------------------------------------------------------------------

test('parseRentalIdFromResponse: TrustOTP rentalId', () => {
  assert.equal(parseRentalIdFromResponse('{"success":true,"rentalId":1793616}'), 1793616);
});

test('parseRentalIdFromResponse: snake_case rental_id', () => {
  assert.equal(parseRentalIdFromResponse('{"rental_id":42}'), 42);
});

test('parseRentalIdFromResponse: bare id fallback', () => {
  assert.equal(parseRentalIdFromResponse('{"id":7}'), 7);
});

test('parseRentalIdFromResponse: regex fallback when JSON is malformed', () => {
  assert.equal(parseRentalIdFromResponse('garbage "rentalId": 99 trailing'), 99);
});

test('parseRentalIdFromResponse: empty / null body → null', () => {
  assert.equal(parseRentalIdFromResponse(''), null);
  assert.equal(parseRentalIdFromResponse(null), null);
  assert.equal(parseRentalIdFromResponse(undefined), null);
});

test('parseRentalIdFromResponse: rentalId=0 → null (must be positive)', () => {
  assert.equal(parseRentalIdFromResponse('{"rentalId":0}'), null);
});

test('parseRentalIdFromResponse: non-numeric → null', () => {
  assert.equal(parseRentalIdFromResponse('{"rentalId":"abc"}'), null);
});

// ----------------------------------------------------------------------------
// buildRentalUpsertBody — pure mapper from webhook payload + sim context →
// rentals upsert body. Mirrors the live schema exactly:
//   reseller_id BIGINT NOT NULL
//   sim_id      BIGINT NOT NULL
//   sim_number_id BIGINT NOT NULL
//   carrier     TEXT NOT NULL CHECK (carrier IN ('att','tmobile'))
//   e164        TEXT
//   reseller_rental_id TEXT
//   rental_date DATE NOT NULL
// ----------------------------------------------------------------------------

const ctx = {
  payload: {
    event_type: 'number.online',
    data: {
      sim_id: 998,
      number: '+17122058546',
      iccid: '89014104334606222126',
    },
  },
  responseBody: '{"success":true,"message":"Rental created","rentalId":1793616}',
  resellerId: 3,
  sim: { id: 998, carrier: 'att' },
  simNumber: { id: 80952, sim_id: 998, e164: '+17122058546' },
  deliveredAt: '2026-06-10T04:23:06.050Z',
};

test('buildRentalUpsertBody: full mapping for an att SIM', () => {
  const body = buildRentalUpsertBody(ctx);
  assert.equal(body.reseller_id, 3);
  assert.equal(body.sim_id, 998);
  assert.equal(body.sim_number_id, 80952);
  assert.equal(body.carrier, 'att');
  assert.equal(body.e164, '+17122058546');
  assert.equal(body.reseller_rental_id, '1793616');
  assert.equal(body.rental_date, '2026-06-10');
});

test('buildRentalUpsertBody: tmobile carrier normalization from payload "T-Mobile"', () => {
  const body = buildRentalUpsertBody({
    ...ctx,
    sim: { id: 998, carrier: null },
    payload: { event_type: 'number.online', data: { sim_id: 998, number: '+15555550000', carrier: 'T-Mobile' } },
  });
  assert.equal(body.carrier, 'tmobile');
});

test('buildRentalUpsertBody: returns null when rentalId is missing', () => {
  const body = buildRentalUpsertBody({
    ...ctx,
    responseBody: '{"success":true}',
  });
  assert.equal(body, null);
});

test('buildRentalUpsertBody: returns null when sim_number is missing (cannot map)', () => {
  const body = buildRentalUpsertBody({ ...ctx, simNumber: null });
  assert.equal(body, null);
});

test('buildRentalUpsertBody: returns null for non-att/tmobile carrier', () => {
  const body = buildRentalUpsertBody({
    ...ctx,
    sim: { id: 998, carrier: 'verizon' },
    payload: { event_type: 'number.online', data: { sim_id: 998, number: '+1' } },
  });
  assert.equal(body, null);
});

test('buildRentalUpsertBody: ignores non-number.online events', () => {
  const body = buildRentalUpsertBody({
    ...ctx,
    payload: { event_type: 'number.offline', data: { sim_id: 998, number: '+1' } },
  });
  assert.equal(body, null);
});

// ----------------------------------------------------------------------------
// persistRentalFromWebhookResponse — end-to-end behavior with a fake fetch.
// Verifies it: looks up the SIM + sim_numbers row, then POSTs a rentals upsert
// with Prefer: resolution=merge-duplicates. Verifies the idempotency contract:
// it always uses on_conflict=reseller_id,sim_number_id.
// ----------------------------------------------------------------------------

function makeFakeFetch({ sim, simNumber, captureWrite }) {
  return async function fakeFetch(url, init) {
    const u = String(url);
    if (u.includes('/rest/v1/sims?')) {
      return new Response(JSON.stringify(sim ? [sim] : []), { status: 200 });
    }
    if (u.includes('/rest/v1/sim_numbers?')) {
      return new Response(JSON.stringify(simNumber ? [simNumber] : []), { status: 200 });
    }
    if (u.includes('/rest/v1/rentals')) {
      const body = JSON.parse(init.body);
      if (captureWrite) captureWrite({ url: u, init, body });
      return new Response('[]', { status: 201 });
    }
    return new Response('not found', { status: 404 });
  };
}

const fakeEnv = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'fake',
};

test('persistRentalFromWebhookResponse: writes a rentals row when rentalId present', async () => {
  const captured = [];
  const fetchImpl = makeFakeFetch({
    sim: { id: 998, carrier: 'att' },
    simNumber: { id: 80952, sim_id: 998, e164: '+17122058546' },
    captureWrite: (w) => captured.push(w),
  });

  const out = await persistRentalFromWebhookResponse({
    env: fakeEnv,
    payload: ctx.payload,
    responseBody: ctx.responseBody,
    resellerId: 3,
    deliveredAt: ctx.deliveredAt,
    fetchImpl,
  });

  assert.equal(out.ok, true);
  assert.equal(out.upserted, true);
  assert.equal(out.rentalContext.reseller_rental_id, '1793616');
  assert.equal(out.rentalContext.sim_number_id, 80952);
  assert.equal(captured.length, 1);
  const w = captured[0];
  assert.match(w.url, /on_conflict=reseller_id%2Csim_number_id|on_conflict=reseller_id,sim_number_id/);
  assert.equal(w.init.headers['Prefer'], 'resolution=merge-duplicates');
  assert.equal(w.body.reseller_id, 3);
  assert.equal(w.body.reseller_rental_id, '1793616');
  assert.equal(w.body.sim_number_id, 80952);
});

test('persistRentalFromWebhookResponse: no rentalId → no write, returns skipped reason', async () => {
  const captured = [];
  const fetchImpl = makeFakeFetch({
    sim: { id: 998, carrier: 'att' },
    simNumber: { id: 80952, sim_id: 998, e164: '+17122058546' },
    captureWrite: (w) => captured.push(w),
  });

  const out = await persistRentalFromWebhookResponse({
    env: fakeEnv,
    payload: ctx.payload,
    responseBody: '{"success":true}',
    resellerId: 3,
    fetchImpl,
  });

  assert.equal(out.ok, true);
  assert.equal(out.upserted, false);
  assert.equal(out.reason, 'no_rental_id_in_response');
  assert.equal(captured.length, 0);
});

test('persistRentalFromWebhookResponse: no sim_numbers match → skipped, no write', async () => {
  const captured = [];
  const fetchImpl = makeFakeFetch({
    sim: { id: 998, carrier: 'att' },
    simNumber: null,
    captureWrite: (w) => captured.push(w),
  });

  const out = await persistRentalFromWebhookResponse({
    env: fakeEnv,
    payload: ctx.payload,
    responseBody: ctx.responseBody,
    resellerId: 3,
    fetchImpl,
  });

  assert.equal(out.ok, true);
  assert.equal(out.upserted, false);
  assert.equal(out.reason, 'sim_number_not_found');
  assert.equal(captured.length, 0);
});

test('persistRentalFromWebhookResponse: ignores non-delivered events with no rentalId', async () => {
  const captured = [];
  const fetchImpl = makeFakeFetch({
    sim: { id: 998, carrier: 'att' },
    simNumber: { id: 80952, sim_id: 998, e164: '+1' },
    captureWrite: (w) => captured.push(w),
  });

  const out = await persistRentalFromWebhookResponse({
    env: fakeEnv,
    payload: { event_type: 'number.offline', data: { sim_id: 998, number: '+1' } },
    responseBody: '{"rentalId":1}',
    resellerId: 3,
    fetchImpl,
  });

  assert.equal(out.ok, true);
  assert.equal(out.upserted, false);
  assert.equal(out.reason, 'not_number_online');
  assert.equal(captured.length, 0);
});
