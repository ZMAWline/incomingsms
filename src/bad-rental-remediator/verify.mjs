// =========================================================
// §C SMS VERIFICATION — pure logic (INC-19 / INC-16c).
//
// No IO here. Lives next to cooldown.mjs / classifier.mjs so the
// remediator and unit fixtures share the same primitives.
//
// Public surface:
//   mintNonce(reportId, attemptNo)         → Promise<string> (8 hex chars)
//   buildVerifyBody({ reportId, simId, nonce }) → string  (≤160 chars)
//   parseVerifyBody(body)                  → { reportId, simId, nonce } | null
//   cleanRecheckPredicate(ctx)             → { passed, reason? }
//
// The nonce is derived from (reportId, attemptNo) via SHA-256 — fully
// deterministic so a worker retry / journal replay regenerates the same
// payload and the receive poll can still match. No Math.random / Date.now.
// =========================================================

export const VERIFY_BODY_PREFIX = 'IncomingSMS test';
export const VERIFY_BODY_MAX = 160;
export const NONCE_LEN = 8;

export async function mintNonce(reportId, attemptNo) {
  if (reportId === null || reportId === undefined || reportId === '') {
    throw new Error('mintNonce_missing_report_id');
  }
  if (!Number.isFinite(Number(attemptNo)) || Number(attemptNo) < 1) {
    throw new Error('mintNonce_bad_attempt_no');
  }
  const seed = 'v1:' + String(reportId) + ':' + String(attemptNo);
  const data = new TextEncoder().encode(seed);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex.slice(0, NONCE_LEN);
}

export function buildVerifyBody({ reportId, simId, nonce }) {
  if (!reportId) throw new Error('buildVerifyBody_missing_report_id');
  if (!simId)    throw new Error('buildVerifyBody_missing_sim_id');
  if (!nonce || String(nonce).length !== NONCE_LEN) {
    throw new Error('buildVerifyBody_bad_nonce');
  }
  const body = VERIFY_BODY_PREFIX + ' ' + reportId + ' ' + simId + ' ' + nonce;
  if (body.length > VERIFY_BODY_MAX) {
    throw new Error('buildVerifyBody_too_long:' + body.length);
  }
  return body;
}

// Useful for fixtures and inbound-poll matching when we want strict parsing
// rather than substring-on-nonce. The receive poll itself substring-matches
// the nonce (per §C.3) so this is mostly diagnostic.
export function parseVerifyBody(body) {
  if (typeof body !== 'string') return null;
  const m = body.match(/^IncomingSMS test (\S+) (\S+) ([0-9a-f]{8})\b/);
  if (!m) return null;
  return { reportId: m[1], simId: m[2], nonce: m[3] };
}

// =========================================================
// §C.4 — clean-recheck composite predicate.
//
//   ctx = {
//     vendorRead:        { healthy: bool, ... } | null  — §C.4.1
//     autoAction:        { completed: bool, error?: any } | null — §C.4.2
//     webhookDelivered:  bool                            — §C.4.3
//     smsReceived:       bool                            — §C.4.4
//     situationExtras:   { requirePortOnline?, portOnline? } — §C.4.5
//   }
//
// Returns { passed: true } or { passed: false, reason: 'vendor_read_unhealthy' | ... }.
// Per §C: ANY false → outcome no_change/failed, no `remediated` close.
// =========================================================

export function cleanRecheckPredicate(ctx) {
  const c = ctx || {};
  if (!c.vendorRead || c.vendorRead.healthy !== true) {
    return { passed: false, reason: 'vendor_read_unhealthy' };
  }
  if (!c.autoAction || c.autoAction.completed !== true || c.autoAction.error) {
    return { passed: false, reason: 'auto_action_not_complete' };
  }
  if (c.webhookDelivered !== true) {
    return { passed: false, reason: 'webhook_not_delivered' };
  }
  if (c.smsReceived !== true) {
    return { passed: false, reason: 'sms_not_received' };
  }
  if (c.situationExtras && c.situationExtras.requirePortOnline === true
      && c.situationExtras.portOnline !== true) {
    return { passed: false, reason: 'port_not_online' };
  }
  return { passed: true };
}
