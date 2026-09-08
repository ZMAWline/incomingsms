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
// `sims.gateway_host` is NOT NULL in the DB, so a row read from Postgres always
// carries an explicit host. The fallback below only fires for SIM-shaped objects
// built in code or tests that omit the field; when it does, it resolves to
// TELTIK, because all production SIMs are Teltik-hosted as of 2026-09-04 and the
// SkyLine hardware is legacy.
//
// This fallback used to derive from `vendor` (teltik => Teltik, everything else
// => Skyline). That was correct when SkyLine was the live host and is now exactly
// backwards: it hands an atomic-vendor SIM `setImei: true` / `portReset: false`,
// the inverse of what its actual Teltik host supports. The DB column default was
// flipped to 'teltik' in the same change (migrations/20260904_sims_gateway_host_
// default_teltik.sql) so the two defaults agree — they disagreed before, and the
// mismatch silently mislabeled the entire 2026-08-24 → 09-04 port-in cohort.
//
// Legacy SkyLine-seated rows are unaffected: they hold an explicit 'skyline'
// value, which still wins. Pure functions only; no IO. Unit-tested directly
// (tests/gateway-host.test.mjs).
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
// `sim.gateway_host` when it is exactly 'skyline' or 'teltik'; otherwise falls
// back to TELTIK (see header — all live SIMs are Teltik-hosted; SkyLine is
// legacy and always carries an explicit value). Null/undefined-safe.
export function gatewayHostOf(sim) {
  const s = sim || {};
  if (s.gateway_host === SKYLINE || s.gateway_host === TELTIK) return s.gateway_host;
  return TELTIK;
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
