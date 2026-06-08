// =========================================================
// §B IMEI correctness check — pure logic (INC-18 / INC-16b)
//
// Inputs (all pre-fetched by the worker):
//   sim       : { vendor, imei }
//   pool      : { device_type } for sim.imei lookup, or null if not in pool
//   gatewayImei: string | null  — IMEI reported by the gateway port (SkyLine)
//   vendorImei : string | null  — IMEI from vendor inquiry (Atomic BLIMEI/NWIMEI,
//                                  Helix details). Wing IoT does not carry IMEI.
//
// Output (discriminated):
//   { ok: true }                         — all signals match expected type
//   { ok: false, reason: 'imei_wrong_type', expected, got }
//   { ok: false, reason: 'imei_drift_gateway', db_imei, gateway_imei }
//   { ok: false, reason: 'imei_drift_vendor',  db_imei, vendor_imei }
//   { ok: false, reason: 'imei_not_in_pool',   db_imei }
//   { ok: false, reason: 'vendor_does_not_carry_imei', vendor } — informational, not failure
//
// Forbidden for auto: any IMEI write. The classifier turns wrong_type / drift
// into operator escalations except the A7 vendor-IMEI-correct-type case which
// gets a DB-only sync via db_sync_upsert (no IMEI rewrite on vendor or gateway).
// =========================================================

export const EXPECTED_DEVICE_TYPE = Object.freeze({
  wing_iot: 'router',
  atomic:   'phone',
  helix:    'phone',
  teltik:   'phone',
});

export function expectedDeviceType(vendor) {
  return EXPECTED_DEVICE_TYPE[String(vendor || '').toLowerCase()] || null;
}

export function checkImeiCorrectness({ sim, pool, gatewayImei, vendorImei } = {}) {
  const vendor = String(sim?.vendor || '').toLowerCase();
  const expected = expectedDeviceType(vendor);
  const dbImei = sim?.imei || null;

  if (!expected) return { ok: false, reason: 'unknown_vendor', vendor };
  if (!dbImei)   return { ok: false, reason: 'missing_db_imei', vendor };

  // 1. Pool lookup
  if (!pool) {
    return { ok: false, reason: 'imei_not_in_pool', db_imei: dbImei };
  }
  if (String(pool.device_type) !== expected) {
    return {
      ok: false, reason: 'imei_wrong_type',
      expected, got: pool.device_type, db_imei: dbImei,
    };
  }

  // 2. DB vs gateway
  if (gatewayImei && normalizeImei(gatewayImei) !== normalizeImei(dbImei)) {
    return {
      ok: false, reason: 'imei_drift_gateway',
      db_imei: dbImei, gateway_imei: gatewayImei,
    };
  }

  // 3. DB vs vendor (Atomic/Helix only; Wing does not carry IMEI)
  if (vendor === 'wing_iot') {
    // Wing-side IMEI is not carried; treat that as ok if pool+gateway match.
    return { ok: true };
  }
  if (vendorImei && normalizeImei(vendorImei) !== normalizeImei(dbImei)) {
    return {
      ok: false, reason: 'imei_drift_vendor',
      db_imei: dbImei, vendor_imei: vendorImei,
    };
  }

  return { ok: true };
}

export function normalizeImei(s) {
  if (s === null || s === undefined) return null;
  return String(s).replace(/\D+/g, '');
}
