// storefront — customer-facing SMS-number day-rental shop.
//
// Serves /api/* (JSON) and /ipn/nowpayments (payment webhook); everything else
// falls through to static assets (public/index.html landing + public/app.html
// app). Reads sims / sim_numbers / inbound_sms, writes only shop_* tables.
// Stock is opt-in via shop_pool; money is an append-only ledger (shop_ledger),
// and the two race-prone moves (balance debit, double-rent of a sim) are
// enforced inside Postgres by the shop_claim_rental RPC + a partial unique
// index — never by application code.

import { BRAND } from './brand.mjs';
import { hashPassword, verifyPassword, randomHex } from './auth.mjs';
import {
  normalizeToE164,
  vendorToCarrier,
  areaCode,
  maskNumber,
  priceFor,
  durationToHours,
  durationFromHours,
  parseBearerToken,
} from './logic.mjs';

const COOKIE_NAME = 'nb_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MIN_DEPOSIT_CENTS = 1000;

// All three duration price columns; vendor rows may hold NULLs (priceFor
// falls back per-column to the 'default' row, then derives from daily).
const PRICES_SELECT =
  'shop_prices?select=vendor,daily_price_cents,weekly_price_cents,monthly_price_cents';

// ---------------------------------------------------------------------------
// relayFetch — copied from src/mdn-rotator/index.js. Project constraint: ALL
// outbound HTTP from workers goes through this helper so traffic can be pinned
// to the relay's egress IP when RELAY_URL/RELAY_KEY are configured. With no
// relay configured it is a plain fetch.
// ---------------------------------------------------------------------------
function relayFetch(env, url, init) {
  if (env.RELAY_URL && env.RELAY_KEY) {
    return fetch(`${env.RELAY_URL}/${url}`, {
      ...init,
      headers: {
        ...(init?.headers || {}),
        'x-relay-key': env.RELAY_KEY,
      },
    });
  }
  return fetch(url, init);
}

// ---------------------------------------------------------------------------
// Supabase (PostgREST) helpers — same shape as src/reseller-portal/index.js,
// but routed through relayFetch per the constraint above.
// ---------------------------------------------------------------------------
function sbHeaders(env, extra) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    Accept: 'application/json',
    ...(extra || {}),
  };
}

async function sbSelect(env, path) {
  const res = await relayFetch(env, `${env.SUPABASE_URL}/rest/v1/${path}`, {
    headers: sbHeaders(env),
  });
  if (!res.ok) {
    throw new Error('PostgREST GET ' + res.status + ': ' + (await res.text().catch(() => '')));
  }
  return res.json();
}

// Insert one row, return the created row (Prefer: representation).
async function sbInsert(env, table, body) {
  const res = await relayFetch(env, `${env.SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: sbHeaders(env, {
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    }),
    body: JSON.stringify(body),
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    const err = new Error('PostgREST POST ' + table + ' ' + res.status + ': ' + text);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  const rows = JSON.parse(text);
  return Array.isArray(rows) ? rows[0] : rows;
}

async function sbPatch(env, path, body) {
  const res = await relayFetch(env, `${env.SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: sbHeaders(env, { 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error('PostgREST PATCH ' + res.status + ': ' + (await res.text().catch(() => '')));
  }
}

async function sbDelete(env, path) {
  const res = await relayFetch(env, `${env.SUPABASE_URL}/rest/v1/${path}`, {
    method: 'DELETE',
    headers: sbHeaders(env, { Prefer: 'return=minimal' }),
  });
  if (!res.ok) {
    throw new Error('PostgREST DELETE ' + res.status + ': ' + (await res.text().catch(() => '')));
  }
}

// Call an RPC; returns { ok, status, text } so callers can map DB errors
// (e.g. raised 'insufficient_balance', unique violations) to HTTP codes.
async function sbRpc(env, fn, args) {
  const res = await relayFetch(env, `${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: sbHeaders(env, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(args),
  });
  const text = await res.text().catch(() => '');
  return { ok: res.ok, status: res.status, text };
}

// ---------------------------------------------------------------------------
// Small response / request utilities
// ---------------------------------------------------------------------------
function json(body, status = 200, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...(extraHeaders || {}) },
  });
}

function sessionCookie(token, maxAgeSeconds) {
  return (
    `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`
  );
}

function getSessionToken(request) {
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(new RegExp('(?:^|; )' + COOKIE_NAME + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}

async function readJsonBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function selectIn(env, table, column, ids, rest) {
  if (!ids.length) return [];
  const out = [];
  for (const part of chunk(ids, 150)) {
    const list = part.map((v) => encodeURIComponent(v)).join(',');
    out.push(...(await sbSelect(env, `${table}?${column}=in.(${list})&${rest}`)));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Auth / sessions
// ---------------------------------------------------------------------------
async function createSession(env, customerId) {
  const token = randomHex(32); // 32 random bytes, hex-encoded
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await sbInsert(env, 'shop_sessions', {
    token,
    customer_id: customerId,
    expires_at: expiresAt,
  });
  return { token, maxAge: Math.floor(SESSION_TTL_MS / 1000) };
}

// Returns the customer row, or a Response (401/403) the route should return.
// Two credentials are accepted on every authed endpoint:
//   1. Authorization: Bearer <api_token> — for scripts / AI agents. The token
//      is a random 32-hex secret looked up by indexed equality; tokens carry
//      no structure so there is nothing timing-sensitive to compare in JS.
//   2. The nb_session cookie — for the browser app.
async function requireCustomer(request, env) {
  const bearer = parseBearerToken(request.headers.get('Authorization'));
  if (bearer) {
    const customers = await sbSelect(
      env,
      `shop_customers?api_token=eq.${encodeURIComponent(bearer)}&select=id,email,status,api_token&limit=1`
    );
    const customer = customers[0];
    if (!customer) return json({ error: 'unauthorized' }, 401);
    if (customer.status === 'banned') return json({ error: 'account_disabled' }, 403);
    return customer;
  }

  const token = getSessionToken(request);
  if (!token) return json({ error: 'unauthorized' }, 401);
  const sessions = await sbSelect(
    env,
    `shop_sessions?token=eq.${encodeURIComponent(token)}&select=customer_id,expires_at&limit=1`
  );
  const sess = sessions[0];
  if (!sess || Date.parse(sess.expires_at) <= Date.now()) {
    return json({ error: 'unauthorized' }, 401);
  }
  const customers = await sbSelect(
    env,
    `shop_customers?id=eq.${sess.customer_id}&select=id,email,status,api_token&limit=1`
  );
  const customer = customers[0];
  if (!customer) return json({ error: 'unauthorized' }, 401);
  if (customer.status === 'banned') return json({ error: 'account_disabled' }, 403);
  return customer;
}

async function handleSignup(request, env) {
  const body = await readJsonBody(request);
  const email = String(body?.email || '').trim().toLowerCase();
  const password = String(body?.password || '');
  if (!EMAIL_RE.test(email)) return json({ error: 'invalid_email' }, 400);
  if (password.length < 8) return json({ error: 'password_too_short' }, 400);

  const passwordHash = await hashPassword(password);
  let customer;
  try {
    customer = await sbInsert(env, 'shop_customers', {
      email,
      password_hash: passwordHash,
      api_token: randomHex(16), // 32-hex token for the future Telegram bot
    });
  } catch (e) {
    if (e.status === 409 || /23505|duplicate key/.test(String(e.body || ''))) {
      return json({ error: 'email_taken' }, 409);
    }
    throw e;
  }
  const { token, maxAge } = await createSession(env, customer.id);
  return json(
    { ok: true, email: customer.email },
    200,
    { 'Set-Cookie': sessionCookie(token, maxAge) }
  );
}

async function handleLogin(request, env) {
  const body = await readJsonBody(request);
  const email = String(body?.email || '').trim().toLowerCase();
  const password = String(body?.password || '');
  const rows = email
    ? await sbSelect(
        env,
        `shop_customers?email=eq.${encodeURIComponent(email)}&select=id,email,status,password_hash&limit=1`
      )
    : [];
  const customer = rows[0];
  // Generic 401 on bad credentials — never reveal whether the email exists.
  if (!customer || !(await verifyPassword(password, customer.password_hash))) {
    return json({ error: 'invalid_credentials' }, 401);
  }
  if (customer.status === 'banned') return json({ error: 'account_disabled' }, 403);
  const { token, maxAge } = await createSession(env, customer.id);
  return json(
    { ok: true, email: customer.email },
    200,
    { 'Set-Cookie': sessionCookie(token, maxAge) }
  );
}

async function handleLogout(request, env) {
  const token = getSessionToken(request);
  if (token) {
    try {
      await sbDelete(env, `shop_sessions?token=eq.${encodeURIComponent(token)}`);
    } catch (e) {
      console.log('[Logout] session delete failed: ' + e);
    }
  }
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
}

// ---------------------------------------------------------------------------
// Public catalogue
// ---------------------------------------------------------------------------
async function handleConfig(env) {
  return json({
    brand: BRAND,
    deposits_mode: env.NOWPAYMENTS_API_KEY ? 'crypto' : 'manual',
    min_deposit_cents: MIN_DEPOSIT_CENTS,
  });
}

// Shared availability query behind both /api/stock and /api/stats. Resolves the
// set of currently-sellable sims: in shop_pool ∩ sims.status='active' ∩ has a
// current sim_numbers row (valid_to is null) ∩ NOT in an active shop_rental.
// Returns one entry per available sim with its vendor + current e164 — callers
// decide how much (if anything) to expose.
async function availableSims(env) {
  const pool = await sbSelect(env, 'shop_pool?select=sim_id');
  const poolIds = pool.map((r) => r.sim_id);
  if (!poolIds.length) return [];

  const [sims, numbers, activeRentals] = await Promise.all([
    selectIn(env, 'sims', 'id', poolIds, 'status=eq.active&select=id,vendor'),
    selectIn(env, 'sim_numbers', 'sim_id', poolIds, 'valid_to=is.null&select=sim_id,e164'),
    selectIn(env, 'shop_rentals', 'sim_id', poolIds, 'status=eq.active&select=sim_id'),
  ]);

  const numberBySim = new Map(numbers.map((n) => [n.sim_id, n.e164]));
  const rentedSims = new Set(activeRentals.map((r) => r.sim_id));

  const out = [];
  for (const sim of sims) {
    if (rentedSims.has(sim.id)) continue;
    const e164 = numberBySim.get(sim.id);
    if (!e164) continue;
    out.push({ sim_id: sim.id, vendor: sim.vendor, e164 });
  }
  return out;
}

async function handleStock(env) {
  const [available, prices] = await Promise.all([
    availableSims(env),
    sbSelect(env, PRICES_SELECT),
  ]);

  const stock = available.map((s) => {
    const tier = {
      day: priceFor(s.vendor, 'day', prices),
      week: priceFor(s.vendor, 'week', prices),
      month: priceFor(s.vendor, 'month', prices),
    };
    return {
      sim_id: s.sim_id,
      carrier: vendorToCarrier(s.vendor),
      area_code: areaCode(s.e164),
      masked_number: maskNumber(s.e164),
      daily_price_cents: tier.day, // back-compat for older clients
      prices: tier,
    };
  });
  return json({ stock });
}

// Public, no-auth aggregate availability for the landing page. Same query as
// /api/stock but leaks no numbers — only a total count and a per-carrier
// breakdown.
async function handleStats(env) {
  const available = await availableSims(env);
  const carriers = {};
  for (const s of available) {
    const carrier = vendorToCarrier(s.vendor);
    carriers[carrier] = (carriers[carrier] || 0) + 1;
  }
  return json({ available: available.length, carriers });
}

// ---------------------------------------------------------------------------
// Authed: account, renting, inbox
// ---------------------------------------------------------------------------
async function handleMe(customer, env) {
  const balances = await sbSelect(
    env,
    `shop_balances?customer_id=eq.${customer.id}&select=balance_cents&limit=1`
  );
  return json({
    email: customer.email,
    balance_cents: Number(balances[0]?.balance_cents || 0),
    api_token: customer.api_token,
  });
}

// shop_rentals has no duration column: derive the label from the rental
// window so day/week/month rentals self-describe in API responses.
function withDuration(rental) {
  if (!rental || !rental.starts_at || !rental.ends_at) return rental;
  const hours = (Date.parse(rental.ends_at) - Date.parse(rental.starts_at)) / 3600000;
  return { ...rental, duration: durationFromHours(hours) };
}

async function handleRent(customer, env, request) {
  const body = await readJsonBody(request);
  const simId = Number(body?.sim_id);
  if (!Number.isInteger(simId) || simId <= 0) return json({ error: 'invalid_sim_id' }, 400);

  const duration = body?.duration == null ? 'day' : String(body.duration);
  const hours = durationToHours(duration);
  if (hours == null) return json({ error: 'invalid_duration' }, 400);

  // Re-verify sellability. These checks give clean errors for the common
  // cases; the RPC + partial unique index remain the actual race-safety.
  const [pool, sims, numbers, active] = await Promise.all([
    sbSelect(env, `shop_pool?sim_id=eq.${simId}&select=sim_id&limit=1`),
    sbSelect(env, `sims?id=eq.${simId}&status=eq.active&select=id,vendor&limit=1`),
    sbSelect(env, `sim_numbers?sim_id=eq.${simId}&valid_to=is.null&select=e164&order=valid_from.desc&limit=1`),
    sbSelect(env, `shop_rentals?sim_id=eq.${simId}&status=eq.active&select=id&limit=1`),
  ]);
  if (!pool.length || !sims.length || !numbers.length) {
    return json({ error: 'not_available' }, 404);
  }
  if (active.length) return json({ error: 'just_taken' }, 409);

  const vendor = sims[0].vendor;
  const prices = await sbSelect(env, PRICES_SELECT);
  const priceCents = priceFor(vendor, duration, prices);
  const e164 = normalizeToE164(numbers[0].e164);

  const rpc = await sbRpc(env, 'shop_claim_rental', {
    p_customer_id: customer.id,
    p_sim_id: simId,
    p_e164: e164,
    p_carrier: vendorToCarrier(vendor),
    p_price_cents: priceCents,
    p_hours: hours,
  });
  if (!rpc.ok) {
    if (rpc.text.includes('insufficient_balance')) {
      return json({ error: 'insufficient_balance' }, 402);
    }
    if (rpc.status === 409 || /23505|duplicate key/.test(rpc.text)) {
      return json({ error: 'just_taken' }, 409);
    }
    throw new Error('shop_claim_rental failed ' + rpc.status + ': ' + rpc.text.slice(0, 300));
  }
  const rentalId = Number(JSON.parse(rpc.text));
  const rentals = await sbSelect(env, `shop_rentals?id=eq.${rentalId}&select=*&limit=1`);
  return json({ rental: rentals[0] ? withDuration(rentals[0]) : { id: rentalId, duration } });
}

function effectiveStatus(rental, currentE164BySim, nowMs) {
  if (rental.status !== 'active') return { effective_status: rental.status, ended_reason: null };
  const current = currentE164BySim.get(rental.sim_id);
  if (!current || current !== normalizeToE164(rental.e164)) {
    // Number rotated away before the rental window closed.
    return { effective_status: 'ended', ended_reason: 'number_rotated' };
  }
  if (nowMs >= Date.parse(rental.ends_at)) {
    return { effective_status: 'ended', ended_reason: null };
  }
  return { effective_status: 'active', ended_reason: null };
}

async function handleRentals(customer, env) {
  const rentals = await sbSelect(
    env,
    `shop_rentals?customer_id=eq.${customer.id}&select=*&order=created_at.desc&limit=200`
  );
  const activeSimIds = [...new Set(rentals.filter((r) => r.status === 'active').map((r) => r.sim_id))];
  const currentNumbers = await selectIn(
    env, 'sim_numbers', 'sim_id', activeSimIds, 'valid_to=is.null&select=sim_id,e164'
  );
  const currentBySim = new Map(currentNumbers.map((n) => [n.sim_id, normalizeToE164(n.e164)]));
  const now = Date.now();
  return json({
    rentals: rentals.map((r) => ({ ...withDuration(r), ...effectiveStatus(r, currentBySim, now) })),
  });
}

// Regenerate the customer's api_token (same shape as the one minted at
// signup) and hand the fresh one back. The old token dies with the patch —
// the escape hatch for leaked agent credentials.
async function handleRotateToken(customer, env) {
  const newToken = randomHex(16); // 32-hex, matches signup
  await sbPatch(env, `shop_customers?id=eq.${customer.id}`, { api_token: newToken });
  return json({ ok: true, api_token: newToken });
}

async function handleMessages(customer, env, rentalId) {
  const rentals = await sbSelect(
    env,
    `shop_rentals?id=eq.${rentalId}&customer_id=eq.${customer.id}&select=*&limit=1`
  );
  const rental = rentals[0];
  if (!rental) return json({ error: 'not_found' }, 404);

  const target = normalizeToE164(rental.e164);
  const startsMs = Date.parse(rental.starts_at);
  const endsMs = Date.parse(rental.ends_at);

  // The inbox window closes at ends_at OR when the number was rotated off the
  // sim, whichever is earlier — messages after rotation belong to the next
  // tenant of that number.
  const numberRows = await sbSelect(
    env,
    `sim_numbers?sim_id=eq.${rental.sim_id}&select=e164,valid_from,valid_to&order=valid_from.desc&limit=50`
  );
  let windowEndMs = endsMs;
  const span = numberRows.find((n) => {
    if (normalizeToE164(n.e164) !== target) return false;
    const from = n.valid_from ? Date.parse(n.valid_from) : -Infinity;
    const to = n.valid_to ? Date.parse(n.valid_to) : Infinity;
    return from <= endsMs && to > startsMs; // overlaps the rental window
  });
  if (span && span.valid_to) windowEndMs = Math.min(endsMs, Date.parse(span.valid_to));

  const sms = await sbSelect(
    env,
    `inbound_sms?sim_id=eq.${rental.sim_id}` +
      `&received_at=gte.${encodeURIComponent(new Date(startsMs).toISOString())}` +
      `&received_at=lte.${encodeURIComponent(new Date(windowEndMs).toISOString())}` +
      `&select=to_number,from_number,body,received_at&order=received_at.desc&limit=200`
  );
  const messages = sms
    .filter((m) => normalizeToE164(m.to_number) === target)
    .slice(0, 100)
    .map((m) => ({ from_number: m.from_number, body: m.body, received_at: m.received_at }));
  return json({ messages });
}

// ---------------------------------------------------------------------------
// Deposits + NOWPayments IPN
// ---------------------------------------------------------------------------
async function handleCreateDeposit(customer, env, request) {
  const body = await readJsonBody(request);
  const amountCents = Number(body?.amount_cents);
  if (!Number.isInteger(amountCents) || amountCents < MIN_DEPOSIT_CENTS) {
    return json({ error: 'min_deposit', min_deposit_cents: MIN_DEPOSIT_CENTS }, 400);
  }

  if (!env.NOWPAYMENTS_API_KEY) {
    const dep = await sbInsert(env, 'shop_deposits', {
      customer_id: customer.id,
      processor: 'manual',
      amount_cents: amountCents,
      status: 'pending',
    });
    return json({
      mode: 'manual',
      deposit_id: dep.id,
      instructions:
        'Contact ' + BRAND.supportEmail +
        ' to fund your balance; reference deposit #' + dep.id + '.',
    });
  }

  const origin = new URL(request.url).origin;
  const dep = await sbInsert(env, 'shop_deposits', {
    customer_id: customer.id,
    processor: 'nowpayments',
    amount_cents: amountCents,
    status: 'pending',
  });

  const invRes = await relayFetch(env, 'https://api.nowpayments.io/v1/invoice', {
    method: 'POST',
    headers: {
      'x-api-key': env.NOWPAYMENTS_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      price_amount: amountCents / 100,
      price_currency: 'usd',
      order_id: String(dep.id),
      order_description: BRAND.name + ' balance top-up',
      ipn_callback_url: origin + '/ipn/nowpayments',
      success_url: origin + '/',
      cancel_url: origin + '/',
    }),
  });
  const invText = await invRes.text().catch(() => '');
  if (!invRes.ok) {
    console.log('[Deposit] NOWPayments invoice failed ' + invRes.status + ': ' + invText.slice(0, 300));
    await sbPatch(env, `shop_deposits?id=eq.${dep.id}`, { status: 'failed' });
    return json({ error: 'payment_provider_error' }, 502);
  }
  let inv;
  try { inv = JSON.parse(invText); } catch { inv = {}; }
  await sbPatch(env, `shop_deposits?id=eq.${dep.id}`, {
    invoice_id: String(inv.id ?? ''),
    raw: { invoice: inv },
  });
  return json({ mode: 'crypto', deposit_id: dep.id, invoice_url: inv.invoice_url });
}

async function handleListDeposits(customer, env) {
  const deposits = await sbSelect(
    env,
    `shop_deposits?customer_id=eq.${customer.id}` +
      '&select=id,processor,amount_cents,status,created_at,confirmed_at' +
      '&order=created_at.desc&limit=100'
  );
  return json({ deposits });
}

// NOWPayments IPN signature: HMAC-SHA512 over the JSON body re-serialized
// with keys sorted (their documented scheme), hex-encoded, in x-nowpayments-sig.
function sortKeysDeep(v) {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeysDeep(v[k]);
    return out;
  }
  return v;
}

async function hmacSha512Hex(secret, data) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqualStr(a, b) {
  const A = String(a);
  const B = String(b);
  if (A.length !== B.length) return false;
  let diff = 0;
  for (let i = 0; i < A.length; i++) diff |= A.charCodeAt(i) ^ B.charCodeAt(i);
  return diff === 0;
}

async function handleNowpaymentsIpn(request, env) {
  if (!env.NOWPAYMENTS_IPN_SECRET) return json({ error: 'ipn_not_configured' }, 503);

  const rawBody = await request.text();
  let payload;
  try { payload = JSON.parse(rawBody); } catch { return json({ error: 'bad_json' }, 400); }

  const provided = request.headers.get('x-nowpayments-sig') || '';
  const expected = await hmacSha512Hex(
    env.NOWPAYMENTS_IPN_SECRET,
    JSON.stringify(sortKeysDeep(payload))
  );
  if (!constantTimeEqualStr(provided.toLowerCase(), expected)) {
    return json({ error: 'bad_signature' }, 401);
  }

  // Resolve our deposit row: order_id is our shop_deposits.id; fall back to
  // the NOWPayments invoice id if order_id is missing.
  let dep = null;
  const orderId = Number(payload.order_id);
  if (Number.isInteger(orderId) && orderId > 0) {
    const rows = await sbSelect(
      env, `shop_deposits?id=eq.${orderId}&select=id,invoice_id,status&limit=1`
    );
    dep = rows[0] || null;
  }
  if (!dep && payload.invoice_id != null) {
    const rows = await sbSelect(
      env,
      `shop_deposits?invoice_id=eq.${encodeURIComponent(String(payload.invoice_id))}&select=id,invoice_id,status&limit=1`
    );
    dep = rows[0] || null;
  }
  if (!dep || !dep.invoice_id) return json({ ok: true, note: 'unknown_deposit' });

  const status = String(payload.payment_status || '');
  if (status === 'finished' || status === 'confirmed') {
    const amountCents = Number.isFinite(Number(payload.price_amount))
      ? Math.round(Number(payload.price_amount) * 100)
      : null;
    const rpc = await sbRpc(env, 'shop_confirm_deposit', {
      p_invoice_id: dep.invoice_id,
      p_amount_cents: amountCents,
      p_raw: payload,
    });
    if (!rpc.ok) {
      throw new Error('shop_confirm_deposit failed ' + rpc.status + ': ' + rpc.text.slice(0, 300));
    }
    // RPC returns false on retries (already confirmed) — still 200: idempotent.
    return json({ ok: true });
  }
  if ((status === 'failed' || status === 'expired') && dep.status === 'pending') {
    await sbPatch(env, `shop_deposits?id=eq.${dep.id}`, { status, raw: payload });
  }
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      // --- public API ---
      if (path === '/api/config' && method === 'GET') return handleConfig(env);
      if (path === '/api/stock' && method === 'GET') return handleStock(env);
      if (path === '/api/stats' && method === 'GET') return handleStats(env);
      if (path === '/api/signup' && method === 'POST') return handleSignup(request, env);
      if (path === '/api/login' && method === 'POST') return handleLogin(request, env);
      if (path === '/api/logout' && method === 'POST') return handleLogout(request, env);
      if (path === '/ipn/nowpayments' && method === 'POST') return handleNowpaymentsIpn(request, env);

      // --- authed API ---
      if (path.startsWith('/api/')) {
        const messagesMatch = path.match(/^\/api\/rentals\/(\d+)\/messages$/);
        const isAuthedRoute =
          path === '/api/me' || path === '/api/rent' || path === '/api/rentals' ||
          path === '/api/deposits' || path === '/api/token/rotate' || messagesMatch;
        if (isAuthedRoute) {
          const auth = await requireCustomer(request, env);
          if (auth instanceof Response) return auth;
          if (path === '/api/me' && method === 'GET') return handleMe(auth, env);
          if (path === '/api/rent' && method === 'POST') return handleRent(auth, env, request);
          if (path === '/api/rentals' && method === 'GET') return handleRentals(auth, env);
          if (path === '/api/token/rotate' && method === 'POST') return handleRotateToken(auth, env);
          if (messagesMatch && method === 'GET') return handleMessages(auth, env, Number(messagesMatch[1]));
          if (path === '/api/deposits' && method === 'POST') return handleCreateDeposit(auth, env, request);
          if (path === '/api/deposits' && method === 'GET') return handleListDeposits(auth, env);
        }
        return json({ error: 'not_found' }, 404);
      }
      if (path.startsWith('/ipn/')) return json({ error: 'not_found' }, 404);

      // Everything else: static assets (landing + app). The app gates itself
      // client-side via /api/me; there is nothing secret in the static files.
      return env.ASSETS.fetch(request);
    } catch (e) {
      console.log('[Storefront] ' + method + ' ' + path + ' failed: ' + (e && e.stack || e));
      return json({ error: 'internal_error' }, 500);
    }
  },
};
