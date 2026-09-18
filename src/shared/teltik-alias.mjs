// =========================================================
// Teltik line alias (nickname) = ICCID — the ONE rule for foreign-vendor SIMs
// seated in a Teltik gateway.
//
// teltik-worker matches inbound Teltik SMS to a sims row by the ICCID carried
// in the push payload's `nickname` (extractIccidFromAlias) BEFORE falling back
// to the payload MDN. For an Atomic/Wing/Helix SIM hosted on Teltik the payload
// MDN is the Teltik host number, not the service-provider number in our DB, so
// an empty or wrong nickname means every inbound SMS for that line is either
// dropped or attached to the wrong SIM — which then surfaces as a "no SMS
// received" bad-rental report against a perfectly healthy line.
//
// ensureTeltikAlias() is idempotent: read the inventory nickname, POST
// /v1/update-nickname only when it is missing/wrong, read back, verify.
//
// Provider-vs-host rule: /v1/update-nickname is keyed by the MDN Teltik knows
// the line by (resolveTeltikKnownMdn). For a non-teltik-vendor SIM the DB
// current MDN is the service-provider number, NOT a Teltik host number, so the
// resolver's db_current_mdn fallback is never used to key a write here — it
// could relabel a different Teltik line. No sims.vendor / sims.gateway_host /
// sims.msisdn field is ever written by this module.
// =========================================================

import {
  TELTIK_FETCH_TIMEOUT_MS,
  fetchWithTimeout,
  relayUrl,
  relayHeaders,
  teltikGetJson,
  resolveTeltikKnownMdn,
  toTeltik10Digit,
  isInventoryMdnSource,
  MDN_SOURCE_SMS_PAYLOAD,
} from './teltik-known-mdn.mjs';

const TELTIK_BASE = 'https://api.smsgateway.xyz';

export const ALIAS_REASON_MISSING = 'missing_teltik_alias';
export const ALIAS_REASON_MDN_UNRESOLVED = 'teltik_host_mdn_unresolved';
export const ALIAS_REASON_CREDENTIALS = 'teltik_credentials_missing';
export const ALIAS_REASON_UPDATE_FAILED = 'teltik_alias_update_failed';
export const ALIAS_REASON_VERIFY_FAILED = 'teltik_alias_verify_failed';

// --- pure helpers ---------------------------------------------------------

const NICKNAME_KEYS = ['nickname', 'nick_name', 'alias', 'line_alias', 'name', 'label'];

function firstRecord(json) {
  if (Array.isArray(json)) return json.find((r) => r && typeof r === 'object') || null;
  if (json && typeof json === 'object') {
    for (const k of ['line', 'data', 'result']) {
      if (json[k] && typeof json[k] === 'object' && !Array.isArray(json[k])) return json[k];
      if (Array.isArray(json[k])) return json[k].find((r) => r && typeof r === 'object') || null;
    }
    return json;
  }
  return null;
}

// Pull the nickname off a Teltik line record. Returns { present, value }:
// present=false when the record exposes no nickname-like key at all (so the
// caller can tell "Teltik did not say" from "Teltik said empty").
export function nicknameFromLineRecord(json) {
  const rec = firstRecord(json);
  if (!rec) return { present: false, value: '' };
  for (const k of NICKNAME_KEYS) {
    if (Object.prototype.hasOwnProperty.call(rec, k)) {
      const v = rec[k];
      return { present: true, value: v == null ? '' : String(v).trim() };
    }
  }
  return { present: false, value: '' };
}

function recordIccid(rec) {
  if (!rec || typeof rec !== 'object') return '';
  return String(rec.iccid || rec.sim || rec.sim_number || '').replace(/\D/g, '');
}

// /v1/all-lines → the row for this ICCID (or null).
export function lineRowFromAllLines(json, iccid) {
  const want = String(iccid || '').replace(/\D/g, '');
  if (!want) return null;
  let rows = [];
  if (Array.isArray(json)) rows = json;
  else if (json && typeof json === 'object') {
    for (const k of ['lines', 'data', 'results', 'mdns']) {
      if (Array.isArray(json[k])) { rows = json[k]; break; }
    }
  }
  return rows.find((r) => recordIccid(r) === want) || null;
}

// The alias is correct only when it is exactly the ICCID (trimmed).
export function aliasMatchesIccid(nickname, iccid) {
  const want = String(iccid || '').trim();
  return !!want && String(nickname == null ? '' : nickname).trim() === want;
}

// Which Teltik-known MDN sources may key a WRITE for a foreign-vendor line.
// Payload + inventory MDNs are numbers Teltik itself produced for this ICCID;
// the DB fallback is our provider MDN and must never key update-nickname.
export function knownMdnUsableForWrite(known) {
  if (!known || !known.mdn) return false;
  const src = String(known.source || '');
  return src === MDN_SOURCE_SMS_PAYLOAD || isInventoryMdnSource(src);
}

// --- IO -------------------------------------------------------------------

// Read the nickname Teltik currently has for this line. Tries the cheapest
// per-ICCID read first, then get-info by the known MDN, then the account-wide
// inventory. Never throws. Returns { present, value, source, attempts[] }.
export async function readTeltikNickname(env, { iccid, mdn10 } = {}, opts = {}) {
  const timeoutMs = opts.timeoutMs || TELTIK_FETCH_TIMEOUT_MS;
  const out = { present: false, value: '', source: null, attempts: [] };
  if (!env || !env.TELTIK_API_KEY) {
    out.attempts.push({ step: 'nickname_read', ok: false, error: ALIAS_REASON_CREDENTIALS });
    return out;
  }
  const key = encodeURIComponent(env.TELTIK_API_KEY);
  const reads = [];
  if (iccid) {
    reads.push({ source: 'get_phone_number', url: TELTIK_BASE + '/v1/get-phone-number/?apikey=' + key
      + '&iccid=' + encodeURIComponent(iccid), pick: (json) => nicknameFromLineRecord(json) });
  }
  if (mdn10) {
    reads.push({ source: 'get_info', url: TELTIK_BASE + '/v1/get-info?apikey=' + key
      + '&mdn=' + encodeURIComponent(mdn10), pick: (json) => nicknameFromLineRecord(json) });
  }
  if (iccid && opts.allLines !== false) {
    reads.push({ source: 'all_lines', url: TELTIK_BASE + '/v1/all-lines/?apikey=' + key,
      pick: (json) => nicknameFromLineRecord(lineRowFromAllLines(json, iccid)) });
  }
  for (const r of reads) {
    try {
      const res = await teltikGetJson(env, r.url, timeoutMs);
      const picked = res.ok ? r.pick(res.json) : { present: false, value: '' };
      out.attempts.push({
        step: r.source, ok: res.ok && picked.present, http_status: res.http_status,
        error: res.ok ? (picked.present ? null : 'no_nickname_in_response') : 'teltik_http_' + res.http_status,
      });
      if (picked.present) {
        out.present = true;
        out.value = picked.value;
        out.source = r.source;
        return out;
      }
    } catch (e) {
      out.attempts.push({ step: r.source, ok: false, error: String((e && e.message) || e) });
    }
  }
  return out;
}

// POST /v1/update-nickname keyed by the Teltik-known 10-digit MDN. Params go
// in both the query string and a form body — Teltik's endpoints read query
// params everywhere else and this keeps the write shape tolerant. Never throws.
export async function teltikUpdateNickname(env, { mdn10, nickname } = {}, opts = {}) {
  const timeoutMs = opts.timeoutMs || TELTIK_FETCH_TIMEOUT_MS;
  if (!env || !env.TELTIK_API_KEY) return { ok: false, http_status: 0, error: ALIAS_REASON_CREDENTIALS, url: null, body_text: null };
  const norm = toTeltik10Digit(mdn10);
  if (norm.length !== 10) return { ok: false, http_status: 0, error: 'teltik_mdn_invalid:' + norm, url: null, body_text: null };
  const params = new URLSearchParams({ apikey: env.TELTIK_API_KEY, mdn: norm, nickname: String(nickname || '') });
  const url = TELTIK_BASE + '/v1/update-nickname?' + params.toString();
  try {
    const resp = await fetchWithTimeout(relayUrl(env, url), {
      method: 'POST',
      headers: { ...relayHeaders(env), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    }, timeoutMs);
    const text = await resp.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    // Teltik can answer HTTP 200 with an in-body error; treat an explicit
    // status/success=false as a failure so verify-by-read-back still runs.
    const bodyFail = json && typeof json === 'object'
      && (json.success === false || json.status === 'error' || json.status === false);
    return {
      ok: resp.ok && !bodyFail,
      http_status: resp.status,
      error: resp.ok ? (bodyFail ? 'teltik_body_error' : null) : 'teltik_http_' + resp.status,
      url: url.replace(/apikey=[^&]*/, 'apikey=***'),
      body_text: text.slice(0, 1000),
    };
  } catch (e) {
    return { ok: false, http_status: 0, error: String((e && e.message) || e), url: url.replace(/apikey=[^&]*/, 'apikey=***'), body_text: null };
  }
}

// Ensure Teltik's nickname for this line equals the ICCID.
//
// sim: { id?, iccid, vendor?, current_mdn_e164? | db_current_mdn? }
// opts.knownMdn: an already-resolved { mdn, source } from resolveTeltikKnownMdn
//   (skips the resolver); omit to resolve here.
// opts.repair === false: read-only check, never POSTs.
//
// Never throws. Returns:
//   { ok, action: 'noop'|'updated'|'none', reason, iccid, mdn10, mdn_source,
//     before: { present, value, source }, after: { present, value, source }|null,
//     update: { ok, http_status, error, url }|null, trail[] }
// ok=true means the nickname is verified equal to the ICCID right now.
export async function ensureTeltikAlias(env, sim = {}, opts = {}) {
  const s = sim || {};
  const iccid = String(s.iccid || '').trim();
  const out = {
    ok: false, action: 'none', reason: null, iccid: iccid || null,
    mdn10: null, mdn_source: null, before: null, after: null, update: null, trail: [],
    checked_at: new Date().toISOString(),
  };
  if (!iccid) { out.reason = 'iccid_missing'; return out; }
  if (!env || !env.TELTIK_API_KEY) { out.reason = ALIAS_REASON_CREDENTIALS; return out; }

  // 1. Teltik-known host MDN (payload → inventory; DB fallback is NOT usable
  //    to key a write on a foreign-vendor line — see header).
  let known = opts.knownMdn;
  if (known === undefined) {
    try {
      known = await resolveTeltikKnownMdn(env, {
        id: s.id, iccid, current_mdn_e164: s.current_mdn_e164 || s.db_current_mdn || null,
      }, { latestTeltikSms: opts.latestTeltikSms });
    } catch (e) {
      known = null;
      out.trail.push({ step: 'resolve_known_mdn', ok: false, error: String((e && e.message) || e) });
    }
  }
  if (known && known.trail) out.trail.push(...known.trail);
  const writable = knownMdnUsableForWrite(known);
  out.mdn_source = known && known.source ? known.source : null;
  out.mdn10 = known && known.mdn ? toTeltik10Digit(known.mdn) : null;
  if (out.mdn10 && out.mdn10.length !== 10) out.mdn10 = null;

  // 2. Read the current nickname.
  const before = await readTeltikNickname(env, { iccid, mdn10: writable ? out.mdn10 : null }, opts);
  out.before = { present: before.present, value: before.value, source: before.source };
  out.trail.push(...before.attempts);
  if (before.present && aliasMatchesIccid(before.value, iccid)) {
    out.ok = true;
    out.action = 'noop';
    return out;
  }
  out.reason = ALIAS_REASON_MISSING;

  if (opts.repair === false) return out;
  if (!writable || !out.mdn10) {
    out.reason = ALIAS_REASON_MDN_UNRESOLVED;
    return out;
  }

  // 3. Repair, then 4. read back and verify.
  const upd = await teltikUpdateNickname(env, { mdn10: out.mdn10, nickname: iccid }, opts);
  out.update = { ok: upd.ok, http_status: upd.http_status, error: upd.error, url: upd.url };
  out.trail.push({ step: 'update_nickname', ok: upd.ok, http_status: upd.http_status, error: upd.error });
  if (!upd.ok) {
    out.reason = ALIAS_REASON_UPDATE_FAILED;
    return out;
  }
  const after = await readTeltikNickname(env, { iccid, mdn10: out.mdn10 }, opts);
  out.after = { present: after.present, value: after.value, source: after.source };
  out.trail.push(...after.attempts.map((a) => ({ ...a, step: a.step + '_readback' })));
  if (after.present && aliasMatchesIccid(after.value, iccid)) {
    out.ok = true;
    out.action = 'updated';
    out.reason = null;
    return out;
  }
  out.action = 'updated';
  out.reason = ALIAS_REASON_VERIFY_FAILED;
  return out;
}

// Compact, log-safe summary for carrier_api_logs / attempts evidence.
export function summarizeAliasResult(r) {
  if (!r) return null;
  return {
    ok: !!r.ok,
    action: r.action || null,
    reason: r.reason || null,
    iccid: r.iccid || null,
    teltik_host_mdn10: r.mdn10 || null,
    mdn_source: r.mdn_source || null,
    nickname_before: r.before ? (r.before.present ? r.before.value : null) : null,
    nickname_before_readable: !!(r.before && r.before.present),
    nickname_after: r.after ? (r.after.present ? r.after.value : null) : null,
    update_http_status: r.update ? r.update.http_status : null,
    update_error: r.update ? r.update.error : null,
    checked_at: r.checked_at || null,
  };
}
