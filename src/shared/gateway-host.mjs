// =========================================================
// Shared gateway-host resolver + capability matrix.
//
// Two orthogonal axes describe where a SIM lives:
//
//   vendor       = the CARRIER ACCOUNT the line is provisioned on.
//                  atomic / helix / wing_iot = AT&T, teltik = T-Mobile.
//                  Carrier-level ops (activation, suspend/restore, MDN swap,
//                  billing) route on `vendor` and MUST keep doing so.
//
//   gateway_host = the PHYSICAL gateway the SIM card is seated in
//                  ('skyline' | 'teltik'), independent of vendor. Gateway-level
//                  ops (writing the modem IMEI, sending SMS over the AT-command
//                  transport, port resets) route on `gateway_host`, because the
//                  hardware, not the carrier, decides what is possible.
//
// The two usually agree (a teltik-vendor SIM sits in a Teltik gateway) but need
// not: an AT&T (atomic) SIM can be physically seated in a Teltik gateway, which
// changes what gateway operations are available even though carrier ops still
// go to ATOMIC. This module is the ONE place that resolves the host and answers
// "does this host support capability X", so every worker decides identically.
//
// `sims.gateway_host` is a newer column and may be null on older rows; when it
// is absent (or holds an unexpected value) we derive the host from `vendor`:
// teltik-vendor => Teltik gateway, everything else => Skyline. Pure functions
// only; no IO — unit-tested directly (tests/gateway-host.test.mjs).
// =========================================================

export const SKYLINE = 'skyline';
export const TELTIK = 'teltik';

// Per-host capability matrix. A capability is supported only when explicitly
// true; anything missing (unknown capability, unknown host) reads as false.
const CAPABILITIES = {
  [SKYLINE]: { setImei: true, skylineSms: true, portReset: false },
  [TELTIK]: { setImei: false, skylineSms: false, portReset: true },
};

// Resolve the physical gateway host for a SIM. Prefers the explicit
// `sim.gateway_host` when it is exactly 'skyline' or 'teltik'; otherwise derives
// from vendor (teltik => TELTIK, else SKYLINE). Null/undefined-safe.
export function gatewayHostOf(sim) {
  const s = sim || {};
  if (s.gateway_host === SKYLINE || s.gateway_host === TELTIK) return s.gateway_host;
  return s.vendor === 'teltik' ? TELTIK : SKYLINE;
}

export function isTeltikHosted(sim) {
  return gatewayHostOf(sim) === TELTIK;
}

export function isSkylineHosted(sim) {
  return gatewayHostOf(sim) === SKYLINE;
}

// True only when the resolved host explicitly supports `capability`; unknown
// capability or host returns false (never throws).
export function gatewaySupports(sim, capability) {
  const caps = CAPABILITIES[gatewayHostOf(sim)];
  return !!(caps && caps[capability] === true);
}
