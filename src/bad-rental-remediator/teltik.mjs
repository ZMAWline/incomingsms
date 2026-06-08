// =========================================================
// Teltik API boundary helpers (INC-21 / INC-16e).
//
// The remediator MUST pass 10-digit US MDNs to Teltik's
// /v1/reset-network, /v1/reset-port and /v1/port-status. Anything that
// looks like E.164 ("+1XXXXXXXXXX") or has separators must collapse to
// the bare 10-digit subscriber number BEFORE leaving the worker. This is
// the only place E.164→10-digit conversion happens (per Plan §A.4).
// =========================================================

// mdn10(raw) — normalize anything that resembles a US MDN to the 10-digit
// form Teltik expects. Non-US 11+ digit inputs that do not start with '1'
// are returned digits-only and left to Teltik to reject explicitly.
export function mdn10(raw) {
  const digits = String(raw == null ? '' : raw).replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits;
}
