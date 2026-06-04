// INC-3 — Bad-rental report identifier resolver.
//
// Contract (per board directive 2026-06-04): the reseller-facing report-bad
// API accepts ONLY two identifiers:
//   1. `reseller_rental_id` — the reseller's own rental id (string).
//   2. `e164`               — the rental's CURRENT phone number (the MDN that
//                             the SIM is serving right now).
//
// All other identifiers are explicitly rejected:
//   - `sim_id` and `iccid` — a SIM can span multiple MDNs/rentals over time,
//     so identifying a rental by SIM is ambiguous.
//   - `rental_id`          — our internal numeric primary key; not reseller-facing.
//
// Historical/original MDNs are also rejected by construction: the e164 lookup
// matches `sim_numbers.e164 WHERE valid_to IS NULL`, so a rotated-away number
// will not resolve.
//
// Exported as a pure module so the same logic runs in the Worker and in tests.

export const REPORT_REASON_CODES = new Set(['no_sms_received', 'wrong_number', 'delayed_sms', 'other']);

const REJECTED_FIELDS = ['sim_id', 'iccid', 'sim_iccid', 'rental_id'];

export function normalizeE164(input) {
  if (input == null) return null;
  const digits = String(input).replace(/[^0-9]/g, '');
  if (digits.length < 11 || digits.length > 15) return null;
  return '+' + digits;
}

// sbGet is injected so tests can mock PostgREST. Signature mirrors the
// Worker's helper: `sbGet(env, path) → Response`.
export async function resolveRentalForReport(env, resellerId, body, sbGet) {
  body = body || {};

  const rejected = REJECTED_FIELDS.filter(k => body[k] != null);
  if (rejected.length) {
    return {
      ok: false,
      code: 'bad_request',
      message:
        'identifier(s) not accepted: ' + rejected.join(', ') +
        '. Use `reseller_rental_id` (your rental id) or `e164` (the rental\'s current phone number).',
    };
  }

  const hasResellerRentalId =
    body.reseller_rental_id != null && String(body.reseller_rental_id).length > 0;
  const hasE164 = body.e164 != null;

  if (!hasResellerRentalId && !hasE164) {
    return {
      ok: false,
      code: 'bad_request',
      message: '`reseller_rental_id` (your rental id) or `e164` (current phone number) is required',
    };
  }

  if (hasResellerRentalId) {
    const v = String(body.reseller_rental_id);
    const resp = await sbGet(env,
      'rentals?select=id,sim_id,sim_number_id,e164,minted_at' +
      '&reseller_id=eq.' + encodeURIComponent(resellerId) +
      '&reseller_rental_id=eq.' + encodeURIComponent(v) +
      '&order=minted_at.desc&limit=1'
    );
    if (!resp.ok) return { ok: false, code: 'bad_request', message: 'lookup failed' };
    const rows = await resp.json();
    if (!Array.isArray(rows) || rows.length === 0) {
      return { ok: false, code: 'not_found', message: 'reseller_rental_id not found for your account' };
    }
    const r = rows[0];
    return { ok: true, rental_id: r.id, sim_id: r.sim_id, sim_number_id: r.sim_number_id, e164: r.e164 || null };
  }

  // e164: must be the CURRENT MDN (sim_numbers.valid_to IS NULL) of a SIM
  // currently owned by this reseller. We then resolve to that SIM's most-recent
  // rental for the reseller. Original/historical MDNs are NOT accepted.
  const norm = normalizeE164(body.e164);
  if (!norm) return { ok: false, code: 'bad_request', message: 'e164 is not a plausible phone number' };

  const snResp = await sbGet(env,
    'sim_numbers?select=sim_id,e164,valid_to' +
    '&e164=eq.' + encodeURIComponent(norm) +
    '&valid_to=is.null'
  );
  if (!snResp.ok) return { ok: false, code: 'bad_request', message: 'lookup failed' };
  const sns = await snResp.json();
  if (!Array.isArray(sns) || sns.length === 0) {
    return { ok: false, code: 'not_found', message: 'no active SIM with this current phone number under your account' };
  }

  const simIds = sns.map(s => s.sim_id);
  const ownResp = await sbGet(env,
    'reseller_sims?select=sim_id' +
    '&reseller_id=eq.' + encodeURIComponent(resellerId) +
    '&sim_id=in.(' + simIds.map(encodeURIComponent).join(',') + ')'
  );
  if (!ownResp.ok) return { ok: false, code: 'bad_request', message: 'lookup failed' };
  const owned = await ownResp.json();
  if (!Array.isArray(owned) || owned.length === 0) {
    return { ok: false, code: 'not_found', message: 'no active SIM with this current phone number under your account' };
  }
  if (owned.length > 1) {
    return {
      ok: false, code: 'ambiguous',
      message: 'multiple active SIMs share this current number — resubmit with `reseller_rental_id`',
    };
  }

  const ownedSimId = owned[0].sim_id;
  const rResp = await sbGet(env,
    'rentals?select=id,sim_id,sim_number_id,e164,minted_at' +
    '&reseller_id=eq.' + encodeURIComponent(resellerId) +
    '&sim_id=eq.' + encodeURIComponent(ownedSimId) +
    '&order=minted_at.desc&limit=1'
  );
  if (!rResp.ok) return { ok: false, code: 'bad_request', message: 'lookup failed' };
  const rRows = await rResp.json();
  if (!Array.isArray(rRows) || rRows.length === 0) {
    return { ok: false, code: 'not_found', message: 'no rental for this number under your account' };
  }
  const r = rRows[0];
  return { ok: true, rental_id: r.id, sim_id: r.sim_id, sim_number_id: r.sim_number_id, e164: norm };
}
