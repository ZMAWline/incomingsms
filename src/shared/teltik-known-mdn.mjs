// =========================================================
// Teltik-known MDN resolution.
//
// Teltik/TotalTick can keep believing a line's MDN is the FIRST one it ever
// saw: our MDN rotations do not sync back to the Teltik side. (Inbound SMS is
// matched by ICCID-in-alias for the same reason — see teltik-worker.) So when
// we need an MDN that Teltik will recognize (e.g. /v1/get-info, /v1/port-status,
// /v1/reset-port for a SIM seated in a Teltik gateway), the DB's current MDN is
// not authoritative; the raw destination MDN from the latest Teltik-delivered
// inbound SMS payload is. Pure functions only; no IO.
// =========================================================

function payloadDestination(latestTeltikSms) {
  if (!latestTeltikSms) return null;
  const raw = latestTeltikSms.raw || null;
  if (raw && typeof raw === 'object') {
    return raw.destination || raw.to || raw.mdn || raw.msisdn || null;
  }
  return latestTeltikSms.teltik_destination || null;
}

// Pick the MDN Teltik most likely knows the line by. Prefers the latest raw
// Teltik inbound SMS payload destination; falls back to our DB current MDN only
// when no such SMS payload MDN exists. `inbound_sms.to_number` is deliberately
// NOT used here: for Teltik-hosted Atomic/foreign SIMs it is the canonical DB
// number written for customer/reseller display, not the MDN Teltik accepts.
// Returns { mdn, source, received_at } or null.
export function pickTeltikKnownMdn(latestTeltikSms, dbCurrentMdn) {
  const rawDestination = payloadDestination(latestTeltikSms);
  if (rawDestination) {
    return {
      mdn: rawDestination,
      source: 'teltik_inbound_sms_payload_mdn',
      received_at: latestTeltikSms.received_at || null,
    };
  }
  if (dbCurrentMdn) {
    return { mdn: dbCurrentMdn, source: 'db_current_mdn', received_at: null };
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
