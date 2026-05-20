import { ADDRESS_POOL } from './address-pool.mjs';

export const APEX_VENDORS = ['atomic', 'helix'];
export function isApexVendor(vendor) {
  return APEX_VENDORS.includes(vendor);
}

// Build an in-memory id → entry index once per worker invocation.
let _byId = null;
function indexById() {
  if (_byId) return _byId;
  _byId = new Map();
  for (const e of ADDRESS_POOL) _byId.set(e.id, e);
  return _byId;
}

// Pick the least-recently-used PPU address from the pool, excluding any
// entry whose state matches excludeState OR whose zipCode matches excludeZip.
// Returns the full address record. Throws if pool exhausted.
export async function pickNextPpuAddress(env, opts = {}) {
  const excludeState = opts.excludeState ?? null;
  const excludeZip   = opts.excludeZip ?? null;

  const url = `${env.SUPABASE_URL}/rest/v1/rpc/claim_address_pool_entry`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey:        env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ p_exclude_state: excludeState, p_exclude_zip: excludeZip }),
  });
  if (!res.ok) {
    throw new Error(`pickNextPpuAddress: RPC HTTP ${res.status}: ${await res.text()}`);
  }
  const addressId = await res.json();
  if (!addressId || typeof addressId !== 'string') {
    throw new Error(`pickNextPpuAddress: pool exhausted (excludeState=${excludeState} excludeZip=${excludeZip})`);
  }
  const entry = indexById().get(addressId);
  if (!entry) {
    throw new Error(`pickNextPpuAddress: address_id ${addressId} in DB but not in static pool`);
  }
  return entry;
}

// Idempotent seeder. Called once after deploying the static pool change.
// Upserts every static entry into address_pool_usage (last_used_at left NULL
// for new entries, preserved for existing ones).
export async function seedAddressPoolUsage(env) {
  const rows = ADDRESS_POOL.map(e => ({
    address_id: e.id,
    state:      e.state,
    zip_code:   e.zipCode,
  }));
  const url = `${env.SUPABASE_URL}/rest/v1/address_pool_usage?on_conflict=address_id`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type':   'application/json',
      apikey:           env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization:    `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer:           'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`seedAddressPoolUsage HTTP ${res.status}: ${await res.text()}`);
  return rows.length;
}
