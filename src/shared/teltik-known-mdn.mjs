// =========================================================
// Teltik-known MDN resolution — the ONE rule every Teltik per-line call obeys.
//
// Teltik/TotalTick can keep believing a line's MDN is the FIRST one it ever
// saw: our MDN rotations do not sync back to the Teltik side. (Inbound SMS is
// matched by ICCID-in-alias for the same reason — see teltik-worker.) So when
// we need an MDN that Teltik will recognize (e.g. /v1/get-info, /v1/port-status,
// /v1/reset-port for a SIM seated in a Teltik gateway), the DB's current MDN is
// not authoritative.
//
// Resolution order (resolveTeltikKnownMdn):
//   1. latest raw Teltik inbound SMS payload MDN — raw.destination / raw.to /
//      raw.mdn / raw.msisdn of the newest Teltik-delivered inbound_sms row.
//   2. READ-ONLY Teltik inventory lookup when no payload MDN exists:
//      /v1/get-phone-number by ICCID, then /v1/all-lines matched by ICCID —
//      or, failing that, by the DB current MDN, whose presence in the
//      inventory is positive proof Teltik still knows the line by it.
//   3. DB current MDN as the FINAL fallback, tagged db_current_mdn (or
//      db_current_mdn_unconfirmed when an inventory lookup ran and could not
//      confirm it — that read is the one that produces bogus 400/404s).
//
// Provider-vs-host rule: for an Atomic/Wing line hosted on Teltik the
// Teltik host MDN and the service-provider MDN are DIFFERENT numbers. Every
// lookup here is read-only; a resolved Teltik host MDN must never be written
// back into sims.msisdn / sim_numbers.
// =========================================================

const TELTIK_BASE = 'https://api.smsgateway.xyz';

// mdn_source tags written to hosting_port_status_checks.mdn_source and
// reported in remediator/dashboard evidence.
export const MDN_SOURCE_SMS_PAYLOAD = 'teltik_inbound_sms_payload_mdn';
export const MDN_SOURCE_GET_PHONE_NUMBER = 'teltik_get_phone_number_inventory';
export const MDN_SOURCE_ALL_LINES = 'teltik_all_lines_inventory';
export const MDN_SOURCE_DB = 'db_current_mdn';
export const MDN_SOURCE_DB_UNCONFIRMED = 'db_current_mdn_unconfirmed';
export const RETRY_SOURCE_SUFFIX = '_retry';
export const INVENTORY_MDN_SOURCES = [MDN_SOURCE_GET_PHONE_NUMBER, MDN_SOURCE_ALL_LINES];

// True for both the first-pass inventory tags and their _retry variants, so a
// caller never re-runs the same inventory lookup it already used.
export function isInventoryMdnSource(source) {
  const s = String(source || '');
  return INVENTORY_MDN_SOURCES.some((k) => s === k || s === k + RETRY_SOURCE_SUFFIX);
}

// Tag a source as "chosen only after the first port-status read failed", so
// the history distinguishes a retry from a first-choice resolution.
export function retryMdnSource(source) {
  return source ? String(source) + RETRY_SOURCE_SUFFIX : null;
}

// --- pure helpers ---------------------------------------------------------

export function toTeltik10Digit(mdn) {
  if (!mdn) return '';
  const digits = String(mdn).replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

function payloadDestination(latestTeltikSms) {
  if (!latestTeltikSms) return null;
  const raw = latestTeltikSms.raw || null;
  if (raw && typeof raw === 'object') {
    return raw.destination || raw.to || raw.mdn || raw.msisdn || null;
  }
  return latestTeltikSms.teltik_destination || null;
}

// Pick the MDN Teltik most likely knows the line by, WITHOUT any IO. Prefers
// the latest raw Teltik inbound SMS payload destination; falls back to our DB
// current MDN only when no such SMS payload MDN exists. `inbound_sms.to_number`
// is deliberately NOT used here: for Teltik-hosted Atomic/foreign SIMs it is
// the canonical DB number written for customer/reseller display, not the MDN
// Teltik accepts. Returns { mdn, source, received_at } or null.
// Callers that CAN do IO should use resolveTeltikKnownMdn() instead — it adds
// the inventory step between the payload MDN and the DB fallback.
export function pickTeltikKnownMdn(latestTeltikSms, dbCurrentMdn) {
  const rawDestination = payloadDestination(latestTeltikSms);
  if (rawDestination) {
    return {
      mdn: rawDestination,
      source: MDN_SOURCE_SMS_PAYLOAD,
      received_at: latestTeltikSms.received_at || null,
    };
  }
  if (dbCurrentMdn) {
    return { mdn: dbCurrentMdn, source: MDN_SOURCE_DB, received_at: null };
  }
  return null;
}

// PostgREST path for "latest Teltik-delivered inbound SMS for this SIM".
// Teltik webhook rows are the ones without a physical port — sms-ingest
// (Skyline) always records one, teltik-worker inserts port: null. Include raw
// because raw.destination is the Teltik API MDN source of truth.
export function latestTeltikSmsQuery(simId) {
  return 'inbound_sms?select=to_number,received_at,raw&sim_id=eq.' + encodeURIComponent(String(simId))
    + '&port=is.null&raw=not.is.null&order=received_at.desc&limit=1';
}

// /v1/get-phone-number?iccid=... → the MDN Teltik has on file for that card.
export function mdnFromGetPhoneNumber(json) {
  const d = Array.isArray(json) ? json[0] : json;
  if (!d || typeof d !== 'object') return '';
  return toTeltik10Digit(d.msisdn || d.mdn || d.phone_number || d.phoneNumber || d.number || null);
}

function allLinesRows(json) {
  if (Array.isArray(json)) return json;
  if (json && typeof json === 'object') {
    for (const k of ['lines', 'data', 'results', 'mdns']) {
      if (Array.isArray(json[k])) return json[k];
    }
  }
  return [];
}

function lineMdn(row) {
  if (!row || typeof row !== 'object') return '';
  return toTeltik10Digit(row.mdn || row.phone_number || row.number || row.phonenumber || row.msisdn || null);
}

function lineIccid(row) {
  if (!row || typeof row !== 'object') return '';
  return String(row.iccid || row.sim || row.sim_number || '').replace(/\D/g, '');
}

// /v1/all-lines → the account's whole inventory. Match by ICCID first; if that
// fails (e.g. the DB holds a bogus/typo'd 73-char ICCID that Teltik has never
// seen) fall back to confirming the DB MDN is in the inventory — that makes it
// a Teltik-KNOWN MDN rather than an unverified guess.
export function mdnFromAllLines(json, { iccid = null, mdn = null } = {}) {
  const rows = allLinesRows(json);
  const wantIccid = String(iccid || '').replace(/\D/g, '');
  if (wantIccid) {
    for (const row of rows) {
      if (lineIccid(row) && lineIccid(row) === wantIccid) {
        const m = lineMdn(row);
        if (m.length === 10) return m;
      }
    }
  }
  const wantMdn = toTeltik10Digit(mdn);
  if (wantMdn.length === 10) {
    for (const row of rows) {
      if (lineMdn(row) === wantMdn) return wantMdn;
    }
  }
  return '';
}

// --- IO -------------------------------------------------------------------

// Teltik/relay calls can hang until the Worker invocation itself is killed —
// then the batch never finishes and any progress write never runs. Bounding
// every vendor fetch turns a hang into a normal caught exception.
export const TELTIK_FETCH_TIMEOUT_MS = 15_000;

export async function fetchWithTimeout(url, opts = {}, timeoutMs = TELTIK_FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('vendor fetch timeout after ' + timeoutMs + 'ms')), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function relayUrl(env, url) {
  return env && env.RELAY_URL ? env.RELAY_URL + '/' + url : url;
}
function relayHeaders(env) {
  return env && env.RELAY_KEY ? { 'x-relay-key': env.RELAY_KEY } : {};
}

async function teltikGetJson(env, url, timeoutMs) {
  const resp = await fetchWithTimeout(relayUrl(env, url), { method: 'GET', headers: relayHeaders(env) }, timeoutMs);
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { ok: resp.ok, http_status: resp.status, json, text };
}

// READ-ONLY Teltik inventory lookup for a line we have no payload MDN for.
// get-phone-number by ICCID first (one cheap call), then all-lines. Never
// throws; returns { ran, mdn10, source, attempts[], get_phone_number, all_lines }.
// opts.allLines === false skips the (heavier) account-wide list.
export async function teltikInventoryLookup(env, { iccid = null, mdn = null } = {}, opts = {}) {
  const timeoutMs = opts.timeoutMs || TELTIK_FETCH_TIMEOUT_MS;
  const out = { ran: false, mdn10: '', source: null, attempts: [], get_phone_number: null, all_lines: null };
  if (!env || !env.TELTIK_API_KEY) {
    out.attempts.push({ step: 'teltik_inventory', ok: false, error: 'teltik_credentials_missing' });
    return out;
  }
  out.ran = true;
  const key = encodeURIComponent(env.TELTIK_API_KEY);

  if (iccid) {
    try {
      const r = await teltikGetJson(env, TELTIK_BASE + '/v1/get-phone-number/?apikey=' + key
        + '&iccid=' + encodeURIComponent(iccid), timeoutMs);
      const found = r.ok ? mdnFromGetPhoneNumber(r.json) : '';
      out.get_phone_number = { ok: r.ok, http_status: r.http_status, mdn: found || null };
      out.attempts.push({
        step: 'get_phone_number', ok: found.length === 10, http_status: r.http_status,
        error: r.ok ? (found.length === 10 ? null : 'no_mdn_in_response') : 'teltik_http_' + r.http_status,
      });
      if (found.length === 10) {
        out.mdn10 = found;
        out.source = MDN_SOURCE_GET_PHONE_NUMBER;
        return out;
      }
    } catch (e) {
      out.attempts.push({ step: 'get_phone_number', ok: false, error: String((e && e.message) || e) });
    }
  }

  if (opts.allLines === false) return out;
  try {
    const r = await teltikGetJson(env, TELTIK_BASE + '/v1/all-lines/?apikey=' + key, timeoutMs);
    const found = r.ok ? mdnFromAllLines(r.json, { iccid, mdn }) : '';
    out.all_lines = { ok: r.ok, http_status: r.http_status, mdn: found || null };
    out.attempts.push({
      step: 'all_lines', ok: found.length === 10, http_status: r.http_status,
      error: r.ok ? (found.length === 10 ? null : 'line_not_in_inventory') : 'teltik_http_' + r.http_status,
    });
    if (found.length === 10) {
      out.mdn10 = found;
      out.source = MDN_SOURCE_ALL_LINES;
    }
  } catch (e) {
    out.attempts.push({ step: 'all_lines', ok: false, error: String((e && e.message) || e) });
  }
  return out;
}

async function fetchLatestTeltikSms(env, simId) {
  if (!env || !env.SUPABASE_URL || !simId) return null;
  try {
    const resp = await fetch(env.SUPABASE_URL + '/rest/v1/' + latestTeltikSmsQuery(simId), {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json',
      },
    });
    const rows = resp.ok ? await resp.json() : null;
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch {
    return null;
  }
}

// THE shared resolver: payload MDN → Teltik inventory → DB current MDN.
// sim: { id?, iccid?, db_current_mdn? | current_mdn_e164? }.
// opts.latestTeltikSms: pass a row (or null) already read by the caller to
//   skip the Supabase read; omit it to have the resolver do the read.
// opts.skipInventory: skip step 2 entirely (pure payload → DB behavior).
// opts.allLines === false: inventory does get-phone-number only.
// Never throws. Returns { mdn, mdn10, source, received_at, inventory, trail }
// or null when nothing at all resolves.
export async function resolveTeltikKnownMdn(env, sim = {}, opts = {}) {
  const s = sim || {};
  const dbCurrentMdn = s.db_current_mdn || s.current_mdn_e164 || null;
  const trail = [];

  const latestTeltikSms = opts.latestTeltikSms !== undefined
    ? opts.latestTeltikSms
    : await fetchLatestTeltikSms(env, s.id);
  const payloadRaw = payloadDestination(latestTeltikSms);
  const payload10 = toTeltik10Digit(payloadRaw);
  trail.push({
    step: 'inbound_sms_payload', ok: payload10.length === 10,
    error: payloadRaw ? (payload10.length === 10 ? null : 'payload_mdn_not_dialable') : 'no_teltik_sms_payload',
  });
  if (payload10.length === 10) {
    return {
      mdn: payloadRaw, mdn10: payload10, source: MDN_SOURCE_SMS_PAYLOAD,
      received_at: (latestTeltikSms && latestTeltikSms.received_at) || null,
      inventory: null, trail,
    };
  }

  let inventory = null;
  if (opts.skipInventory !== true) {
    inventory = await teltikInventoryLookup(env, { iccid: s.iccid || null, mdn: dbCurrentMdn }, opts);
    trail.push(...inventory.attempts);
    if (inventory.mdn10) {
      return {
        mdn: inventory.mdn10, mdn10: inventory.mdn10, source: inventory.source,
        received_at: null, inventory, trail,
      };
    }
  }

  if (dbCurrentMdn) {
    return {
      mdn: dbCurrentMdn, mdn10: toTeltik10Digit(dbCurrentMdn),
      // Explicit: the inventory ran and did NOT confirm this number, so a
      // port-status 400/404 on it is expected rather than a gateway fault.
      source: inventory && inventory.ran ? MDN_SOURCE_DB_UNCONFIRMED : MDN_SOURCE_DB,
      received_at: null, inventory, trail,
    };
  }
  return null;
}
