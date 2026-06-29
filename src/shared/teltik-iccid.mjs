// =========================================================
// Shared Teltik "Invalid ICCID" detection + heal helpers.
//
// When Teltik replaces a physical SIM card the line's ICCID changes but its
// MDN does not. Every Teltik call keyed by the OLD ICCID then returns
// HTTP 404 with body {"message":"Invalid ICCID."} — change-number (rotation),
// get-phone-number (dashboard "Query"), etc. The heal is always the same:
// resolve the line's CURRENT ICCID via /v1/get-info BY MDN (a read that still
// works because the MDN is stable), then update sims.iccid. The MDN is
// unchanged, so no number churn and no reseller webhook.
//
// These helpers centralise (a) the detection — which historically diverged per
// call site because the body text lives in the response, not the thrown error
// string — and (b) the canonical DB-patch shape, so every fix surface (rotation
// playbook, bad-rental remediator, dashboard Query, SIM Fix button) behaves
// identically. Pure functions only; no IO — unit-tested directly.
// =========================================================

// Body-based detector. Use where the raw response is in hand (status + body).
// `body` may be a parsed object, a JSON string, or arbitrary text.
export function isTeltikInvalidIccidResponse(status, body) {
  if (Number(status) !== 404) return false;
  let msg = '';
  if (body && typeof body === 'object') {
    msg = String(body.message || body.error || '');
  } else if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body);
      msg = String((parsed && (parsed.message || parsed.error)) || body);
    } catch {
      msg = body;
    }
  }
  return /invalid iccid/i.test(msg);
}

// String-based detector. Use where only a persisted error string is available
// (e.g. the rotation playbook matches sims.last_rotation_error). Catches both
// observed shapes whose text differs because the body is not always appended:
//   - "change-number failed 404: {\"message\":\"Invalid ICCID.\"}"   (rotation)
//   - "Teltik query HTTP 404 at ..." / "Teltik query failed: 404"    (query)
// The sync_iccid handler re-verifies via get-info-by-MDN before patching, so a
// slightly looser match here is safe (a false positive resolves to a no-op).
export function isTeltikInvalidIccidError(err) {
  const e = err || '';
  if (/invalid iccid/i.test(e)) return true;
  return /404/.test(e) && /(change-number|teltik query)/i.test(e);
}

// Canonical status_reason audit note for an ICCID swap.
export function iccidSwapStatusReason(oldIccid, newIccid, iso) {
  return 'ICCID swapped from ' + oldIccid + ' to ' + newIccid + ' on ' + (iso || new Date().toISOString());
}

// Canonical DB patch to heal a swapped-card SIM: adopt the new ICCID and clear
// the rotation-failure state so the next rotation window picks the line up.
export function iccidSwapPatch(oldIccid, newIccid, iso) {
  return {
    iccid: newIccid,
    status: 'active',
    rotation_status: 'success',
    rotation_fail_count: 0,
    last_rotation_error: null,
    status_reason: iccidSwapStatusReason(oldIccid, newIccid, iso),
  };
}
