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

import { parseRentalIdFromResponse, persistRentalFromWebhookResponse } from './persist-rental.mjs';

export const REPORT_REASON_CODES = new Set(['no_sms_received', 'wrong_number', 'delayed_sms', 'other']);

const REJECTED_FIELDS = ['sim_id', 'iccid', 'sim_iccid', 'rental_id'];

// Self-heal (2026-06-12): only trust number.online deliveries this recent when
// backfilling a missing rentals row at report-bad intake.
const SELF_HEAL_DELIVERY_WINDOW_DAYS = 14;

export function normalizeE164(input) {
  if (input == null) return null;
  const digits = String(input).replace(/[^0-9]/g, '');
  if (digits.length < 11 || digits.length > 15) return null;
  return '+' + digits;
}

// Rentals lookup for the e164 path: the rental must match the CURRENT
// sim_number (by id) or the current e164 itself — never a historical row.
// Extracted so the self-heal path can re-run it after a backfill.
async function lookupRentalForCurrentNumber(env, resellerId, simId, norm, currentSimNumberId, sbGet) {
  const rResp = await sbGet(env,
    'rentals?select=id,sim_id,sim_number_id,e164,minted_at' +
    '&reseller_id=eq.' + encodeURIComponent(resellerId) +
    '&sim_id=eq.' + encodeURIComponent(simId) +
    '&or=(e164.eq.' + encodeURIComponent(norm)
      + (currentSimNumberId ? (',sim_number_id.eq.' + encodeURIComponent(currentSimNumberId)) : '')
      + ')' +
    '&order=minted_at.desc&limit=1'
  );
  if (!rResp.ok) return { error: true, row: null };
  const rRows = await rResp.json();
  return { error: false, row: Array.isArray(rRows) && rRows.length > 0 ? rRows[0] : null };
}

// Self-heal for the #1 escalation class (`intake_unresolved_current_mdn_no_rental`):
// in most of these cases the proof already exists in webhook_deliveries — the
// most recent delivered `number.online` webhook for the SIM carries the
// reseller's own rentalId in its stored response_body (see persist-rental.mjs,
// incident 2026-06-10). Find such a delivery (matching number, last 14 days),
// and upsert the missing rentals row from it so the report can resolve normally.
async function backfillRentalFromDelivery({ env, resellerId, simId, e164, sbGet, fetchImpl }) {
  const since = new Date(Date.now() - SELF_HEAL_DELIVERY_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const resp = await sbGet(env,
    'webhook_deliveries?select=id,payload,response_body,delivered_at' +
    '&reseller_id=eq.' + encodeURIComponent(resellerId) +
    '&sim_id=eq.' + encodeURIComponent(simId) +
    '&event_type=eq.number.online' +
    '&status=eq.delivered' +
    '&delivered_at=gte.' + encodeURIComponent(since) +
    '&order=delivered_at.desc&limit=5'
  );
  if (!resp.ok) return { upserted: false, reason: 'delivery_lookup_failed' };
  const rows = await resp.json();
  if (!Array.isArray(rows) || rows.length === 0) {
    return { upserted: false, reason: 'no_delivered_number_online' };
  }
  // Most-recent first; require the delivery's number to be the reported
  // current MDN and its response to carry a parseable rentalId.
  const match = rows.find(d =>
    normalizeE164(d && d.payload && d.payload.data && d.payload.data.number) === e164 &&
    parseRentalIdFromResponse(d.response_body) != null
  );
  if (!match) return { upserted: false, reason: 'no_rental_id_in_recent_deliveries' };
  return persistRentalFromWebhookResponse({
    env,
    payload: match.payload,
    responseBody: match.response_body,
    resellerId,
    deliveredAt: match.delivered_at,
    fetchImpl,
  });
}

// sbGet is injected so tests can mock PostgREST. Signature mirrors the
// Worker's helper: `sbGet(env, path) → Response`.
// opts.fetchImpl (optional) backs the self-heal rentals upsert; defaults to
// global fetch inside persist-rental.mjs. Tests inject a stub.
export async function resolveRentalForReport(env, resellerId, body, sbGet, opts) {
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
    'sim_numbers?select=id,sim_id,e164,valid_to' +
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
  // INC-25 followup: the current sim_number row for the resolved e164 (we
  // already filtered by valid_to=is.null above). Use its id to require the
  // rental row to match either the current sim_number_id or the same e164 —
  // without this, the rentals lookup falls back to the latest historical
  // rental on the SIM and silently glues a current-MDN report to a stale
  // rental row (report #3 / report 134 shape).
  const currentSimNumber = sns.find(s => s.sim_id === ownedSimId) || sns[0];
  const currentSimNumberId = currentSimNumber && currentSimNumber.id;

  const looked = await lookupRentalForCurrentNumber(env, resellerId, ownedSimId, norm, currentSimNumberId, sbGet);
  if (looked.error) return { ok: false, code: 'bad_request', message: 'lookup failed' };
  if (looked.row) {
    const r = looked.row;
    return { ok: true, rental_id: r.id, sim_id: r.sim_id, sim_number_id: r.sim_number_id, e164: norm };
  }

  // No rental matches the CURRENT MDN. SELF-HEAL (2026-06-12): before
  // escalating, check whether a recent delivered number.online webhook for
  // this SIM already proved the rental (reseller's rentalId echoed in
  // webhook_deliveries.response_body). If so, backfill the rentals row and
  // re-run the lookup so the report proceeds through the standard pipeline.
  // Any failure here falls through to the unchanged escalation — the heal
  // must never block intake.
  try {
    const healed = await backfillRentalFromDelivery({
      env, resellerId, simId: ownedSimId, e164: norm, sbGet,
      fetchImpl: opts && opts.fetchImpl,
    });
    if (healed && healed.upserted) {
      const again = await lookupRentalForCurrentNumber(env, resellerId, ownedSimId, norm, currentSimNumberId, sbGet);
      if (!again.error && again.row) {
        const r = again.row;
        return {
          ok: true,
          rental_id: r.id,
          sim_id: r.sim_id,
          sim_number_id: r.sim_number_id,
          e164: norm,
          self_healed: 'rental_backfilled_from_delivery',
        };
      }
    }
  } catch (e) {
    // swallow — escalate exactly as before
  }

  // Return unresolved instead of falling back to the latest historical rental
  // on the SIM. The handler stores the report with rental_id=null and
  // immediately flags it `escalated / intake_unresolved_current_mdn_no_rental`
  // so the remediator never vendor-acts against a stale context.
  return {
    ok: true,
    unresolved: true,
    intake_state: 'current_mdn_no_rental_row',
    rental_id: null,
    sim_id: ownedSimId,
    sim_number_id: currentSimNumberId || null,
    e164: norm,
  };
}
