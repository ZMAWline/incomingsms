// The address pool is DB-driven (table: address_pool_usage). The static
// src/shared/address-pool.mjs file is kept only as the original seed source —
// runtime never imports it. New entries (e.g., refill-cron replacements for
// quarantined addresses) just INSERT into the table and are picked up
// automatically by the picker on the next call.

export const APEX_VENDORS = ['atomic', 'helix'];
export function isApexVendor(vendor) {
  return APEX_VENDORS.includes(vendor);
}

// Pick the least-recently-used PPU address from the pool, excluding any
// entry whose state matches excludeState OR whose zipCode matches excludeZip.
// Returns the full address record `{id, streetNumber, streetName, streetDirection, city, state, zipCode}`.
// Throws if pool exhausted.
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
  const entry = await res.json();
  if (!entry || typeof entry !== 'object' || !entry.id) {
    throw new Error(`pickNextPpuAddress: pool exhausted (excludeState=${excludeState} excludeZip=${excludeZip})`);
  }
  return entry;
}

// Quarantine an address after AT&T's verifier rejects it. The picker RPC
// skips rows with verify_failed_at NOT NULL (or older than 90 days) so the
// same bad address never burns a second rotation. Best-effort: errors are
// logged and swallowed — the caller will already re-throw the original
// rotation error, and missing one quarantine row is not worth failing on.
export async function markAddressVerifyFailure(env, addressId, errorMessage) {
  if (!addressId) return;
  const url = `${env.SUPABASE_URL}/rest/v1/address_pool_usage?address_id=eq.${encodeURIComponent(addressId)}`;
  try {
    const res = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Content-Type':  'application/json',
        apikey:          env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization:   `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer:          'return=minimal',
      },
      body: JSON.stringify({
        verify_failed_at:  new Date().toISOString(),
        last_verify_error: String(errorMessage || '').slice(0, 500),
      }),
    });
    if (!res.ok) {
      console.warn(`markAddressVerifyFailure(${addressId}) HTTP ${res.status}: ${await res.text()}`);
    }
  } catch (err) {
    console.warn(`markAddressVerifyFailure(${addressId}) threw: ${err}`);
  }
}

