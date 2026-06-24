// Pure logic for the ATOMIC SIM swap (change ICCID in place). Kept dependency-
// free and unit-tested so the dashboard handler stays thin glue around
// relayFetch + Supabase. See docs/superpowers/specs/2026-06-24-atomic-sim-swap-design.md
//
// A swapSIM keeps the same MSISDN/BAN and moves the line to a new ICCID; the old
// ICCID auto-detaches at the carrier. Only sims.iccid changes on our side.

// Real ATOMIC ICCIDs: 89-prefixed, 19-21 digits total. Same detection the
// dashboard already uses in handleAtomicQuery.
export const ICCID_RE = /^89\d{17,19}$/;

// Reduce any MDN representation to the bare 10-digit US number swapSIM expects.
export function to10DigitMsisdn(raw) {
  if (!raw) return null;
  let d = String(raw).replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d.length === 10 ? d : null;
}

// MSISDN comes from sims.msisdn (ATOMIC stores the 10-digit MDN) or, failing
// that, the active sim_numbers.e164 row reduced to 10 digits.
export function resolveMsisdn(sim) {
  if (!sim) return null;
  const fromCol = to10DigitMsisdn(sim.msisdn);
  if (fromCol) return fromCol;
  const e164 = sim.sim_numbers && sim.sim_numbers[0] && sim.sim_numbers[0].e164;
  return to10DigitMsisdn(e164);
}

// Explicit operator-entered ZIP wins; otherwise the ZIP we recorded at activation.
export function resolveZip(inputZip, sim) {
  const explicit = (inputZip == null ? '' : String(inputZip)).trim();
  if (explicit) return explicit;
  const z = sim && sim.activation_zip ? String(sim.activation_zip).trim() : '';
  return z || null;
}

// { ok: true } or { ok: false, error }.
export function validateNewIccid(newIccid, currentIccid) {
  const v = (newIccid == null ? '' : String(newIccid)).trim();
  if (!v) return { ok: false, error: 'New ICCID is required' };
  if (!ICCID_RE.test(v)) return { ok: false, error: 'New ICCID must be a real ICCID (starts with 89, 19-21 digits)' };
  if (v === String(currentIccid || '').trim()) return { ok: false, error: 'New ICCID is the same as the current ICCID' };
  return { ok: true };
}

export function buildSwapSimRequest({ session, msisdn, zipCode, newSim }) {
  return {
    wholeSaleApi: {
      session,
      wholeSaleRequest: {
        requestType: 'swapSIM',
        MSISDN: msisdn,
        zipCode,
        newSim,
      },
    },
  };
}

export function isSwapSuccess(json) {
  return !!(json && json.wholeSaleApi && json.wholeSaleApi.wholeSaleResponse
    && json.wholeSaleApi.wholeSaleResponse.statusCode === '00');
}

export function swapErrorMessage(json, httpStatus) {
  const wr = json && json.wholeSaleApi && json.wholeSaleApi.wholeSaleResponse;
  if (wr && wr.statusCode) return 'ATOMIC statusCode ' + wr.statusCode + ': ' + (wr.description || '');
  return 'ATOMIC swapSIM HTTP ' + httpStatus;
}
