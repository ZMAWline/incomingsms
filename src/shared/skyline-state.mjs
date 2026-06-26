// Skyline gateway port state codes -> human-readable labels.
//
// Source of truth: the SkyLine-API reference "Port Status Codes" table
// (goip_get_status.html `st` field). Labels are kept verbatim from that table
// (full reference wording, not shortened).
//
// Used by the dashboard worker's /api/gateway-status endpoint (the WING-facing
// read-only gateway status lookup) to convert the numeric `st` into a string
// like "State 3 = Registered (ready)".

export const SKYLINE_STATE_LABELS = {
  0: 'No SIM card',
  1: 'Idle SIM card',
  2: 'Registering',
  3: 'Registered (ready)',
  4: 'Call connected',
  5: 'No balance / alarm',
  6: 'Registration failed',
  7: 'SIM locked by device',
  8: 'SIM locked by operator',
  9: 'SIM card error',
  11: 'Card detected',
  12: 'User locked',
  13: 'Port inter-calling',
  14: 'Inter-calling holding',
  15: 'Access Mobile Network',
  16: 'Module response timeout',
  // Note: code 10 is intentionally absent from the reference table -> "Unknown".
};

// Convert a raw Skyline `st` value into { state_code, state_label, gateway_state }.
// Returns all-null when the state is missing (null/undefined/'' or non-integer).
// Unknown integer codes map to label "Unknown" while keeping the numeric code.
export function formatGatewayState(st) {
  if (st === null || st === undefined || st === '') {
    return { state_code: null, state_label: null, gateway_state: null };
  }
  const code = Number(st);
  if (!Number.isInteger(code)) {
    return { state_code: null, state_label: null, gateway_state: null };
  }
  const label = Object.prototype.hasOwnProperty.call(SKYLINE_STATE_LABELS, code)
    ? SKYLINE_STATE_LABELS[code]
    : 'Unknown';
  return {
    state_code: code,
    state_label: label,
    gateway_state: 'State ' + code + ' = ' + label,
  };
}

// Parse the request's iccid inputs into a clean, de-duplicated, order-preserving
// list. `iccidParam` is the single `?iccid=` value; `iccidsParam` is the
// comma-separated `?iccids=` value. Whitespace is trimmed and empties dropped.
export function parseIccidList(iccidParam, iccidsParam) {
  const raw = [];
  if (iccidParam) raw.push(iccidParam);
  if (iccidsParam) raw.push(...String(iccidsParam).split(','));

  const seen = new Set();
  const out = [];
  for (const candidate of raw) {
    const s = (candidate || '').trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}
