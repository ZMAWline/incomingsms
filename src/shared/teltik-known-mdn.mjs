// =========================================================
// Teltik-known MDN resolution.
//
// Teltik/TotalTick can keep believing a line's MDN is the FIRST one it ever
// saw: our MDN rotations do not sync back to the Teltik side. (Inbound SMS is
// matched by ICCID-in-alias for the same reason — see teltik-worker.) So when
// we need an MDN that Teltik will recognize (e.g. /v1/get-info for a SIM
// seated in a Teltik gateway), the DB's current MDN is not authoritative; the
// destination number of the latest Teltik-delivered inbound SMS is. Pure
// functions only; no IO.
// =========================================================

// Pick the MDN Teltik most likely knows the line by. Prefers the latest
// Teltik inbound SMS destination; falls back to our DB current MDN only when
// no such SMS exists. Returns { mdn, source, received_at } or null.
export function pickTeltikKnownMdn(latestTeltikSms, dbCurrentMdn) {
  if (latestTeltikSms && latestTeltikSms.to_number) {
    return {
      mdn: latestTeltikSms.to_number,
      source: 'teltik_inbound_sms',
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
// (Skyline) always records one, teltik-worker inserts port: null.
export function latestTeltikSmsQuery(simId) {
  return 'inbound_sms?select=to_number,received_at&sim_id=eq.' + encodeURIComponent(String(simId))
    + '&port=is.null&to_number=not.is.null&order=received_at.desc&limit=1';
}
