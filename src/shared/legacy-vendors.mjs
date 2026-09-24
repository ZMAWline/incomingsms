// Legacy vendor switch (owner decision 2026-09-24, replaces PR #134).
//
// Wing IoT, Helix, the SkyLine gateways and the Kasa power strips are no longer
// in use, but their code stays in the repo. Every entry point that would call one
// of them checks legacyVendorEnabled() first and skips when the vendor is off.
//
// env.LEGACY_VENDORS is a comma-separated list, case-insensitive, e.g.
// "helix,wing". "all" enables every vendor. Unset or empty = all OFF (default).
// To re-enable, set it in the worker's wrangler.toml [vars] and deploy.

export const LEGACY_VENDOR_NAMES = ['helix', 'wing', 'skyline', 'kasa'];

export function legacyVendorEnabled(env, name) {
  if (!LEGACY_VENDOR_NAMES.includes(name)) throw new Error(`unknown legacy vendor: ${name}`);
  const list = String(env?.LEGACY_VENDORS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.includes('all') || list.includes(name);
}

// Maps a sims.vendor value to its legacy switch name; null for live vendors.
export function legacyVendorOfSim(simVendor) {
  if (simVendor === 'helix') return 'helix';
  if (simVendor === 'wing_iot') return 'wing';
  return null;
}

// The switch name when this SIM vendor is a legacy vendor that is switched off, else null.
export function disabledLegacyVendorOfSim(env, simVendor) {
  const name = legacyVendorOfSim(simVendor);
  return name && !legacyVendorEnabled(env, name) ? name : null;
}

export function legacyVendorDisabledResult(vendor) {
  return { ok: false, reason: 'legacy_vendor_disabled', vendor };
}

// HTTP 409 for a route that only reaches a switched-off legacy vendor. `worker` names
// the wrangler.toml to edit. The dashboard error toast shows `error`.
export function legacyVendorDisabledResponse(vendor, worker, headers = {}) {
  console.log(`legacy vendor ${vendor} disabled`);
  const body = {
    ...legacyVendorDisabledResult(vendor),
    error: 'legacy vendor disabled',
    how_to_enable: `set LEGACY_VENDORS in ${worker} wrangler.toml [vars]`,
  };
  return new Response(JSON.stringify(body), {
    status: 409,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

export class LegacyVendorDisabledError extends Error {
  constructor(vendor) {
    super(`legacy vendor ${vendor} disabled`);
    this.name = 'LegacyVendorDisabledError';
    this.vendor = vendor;
  }
}

// Throws LegacyVendorDisabledError when the vendor is off. Use at the vendor-call
// helper as a backstop so no code path can reach a disabled vendor.
export function assertLegacyVendorEnabled(env, name) {
  if (!legacyVendorEnabled(env, name)) throw new LegacyVendorDisabledError(name);
}
