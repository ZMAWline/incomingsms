// =========================================================
// number.online / number.offline payloads for operator actions.
//
// The only reseller events are number.online and number.offline. mdn-rotator
// and reseller-sync send them for rotation and line outages; sim-canceller
// (cancel -> offline) and sim-status-changer (suspend -> offline, restore ->
// online) send the same shape so a reseller parses one format.
//
// message_id uses the same per-day hash as mdn-rotator / reseller-sync
// (generateMessageIdAsync), with the reason in the `from` slot so a cancel
// never shares an id with the same day's rotation event for that number.
// =========================================================

export async function numberEventMessageId(eventType, { simId, iccid, number, reason }) {
  const day = new Date().toISOString().slice(0, 10);
  const str = [eventType, simId, iccid, number, reason, '', day].join('|');
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  const hex = Array.from(new Uint8Array(hash)).slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${eventType}_${hex}`;
}

// online=true -> number.online, false -> number.offline. `reason` names the
// operator action (canceled, suspended, restored).
export async function buildNumberEvent({ online, simId, iccid, number, mobilitySubscriptionId, vendor, reason }) {
  const eventType = online ? 'number.online' : 'number.offline';
  return {
    event_type: eventType,
    created_at: new Date().toISOString(),
    message_id: await numberEventMessageId(eventType, { simId, iccid, number, reason }),
    data: {
      sim_id: simId,
      iccid,
      number,
      online,
      mobilitySubscriptionId: mobilitySubscriptionId || null,
      reason,
      carrier: vendor === 'teltik' ? 'T-Mobile' : 'att',
      verified: true,
    },
  };
}
