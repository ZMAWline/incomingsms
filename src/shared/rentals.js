// INC-2: forward-only rental-based billing (Option A) — capture + compute.
//
// Two responsibilities, both dormant by default:
//   - upsertRental(): mint one rental per sim_numbers lifetime per reseller.
//     Idempotent via the rentals UNIQUE(reseller_id, sim_number_id) constraint,
//     so a resend of number.online can never create a second rental and a
//     rotation (new sim_numbers row) always creates a fresh one.
//   - computeRentalBilling(): the rental-mode branch of computeBillingBreakdown.
//     Flat per-carrier rate, one charge per rental, forward-only from a cutover
//     date. Returns the same shape as the legacy engine so callers can swap
//     engines behind the billing_mode flag without reshaping their output.
//
// The legacy EST-day / 48h-block engine in billing.js is untouched and remains
// the default. Nothing here runs unless billing_mode='rental' is explicitly
// passed (compute) or upsertRental is explicitly called (capture).

import { estDateFromDate } from './billing.js';

// Approved forward-only cutover: rentals minted before this EST date are not
// billed in rental mode (past invoices stay on the legacy engine, no backfill).
export const RENTAL_CUTOVER_DATE = '2026-05-22';

// Map an internal vendor to the contractual carrier bucket used for rental
// pricing. AT&T vendors collapse to one rate; Teltik (T-Mobile) to the other.
export function carrierForVendor(vendor) {
  return vendor === 'teltik' ? 'tmobile' : 'att';
}

function sbHeaders(env, extra) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...(extra || {}),
  };
}

async function sbGetAll(env, pathWithoutLimit) {
  const pageSize = 1000;
  const out = [];
  for (let offset = 0; ; offset += pageSize) {
    const sep = pathWithoutLimit.includes('?') ? '&' : '?';
    const url = `${env.SUPABASE_URL}/rest/v1/` + pathWithoutLimit + sep + 'limit=' + pageSize + '&offset=' + offset;
    const resp = await fetch(url, { headers: sbHeaders(env, { Accept: 'application/json' }) });
    if (!resp.ok) throw new Error('PostgREST fetch failed: ' + resp.status + ' ' + (await resp.text()));
    const batch = await resp.json();
    if (!Array.isArray(batch)) return batch;
    out.push(...batch);
    if (batch.length < pageSize) break;
  }
  return out;
}

// Mint (or no-op) the rental for a number lifetime. Call this only after a
// genuine number.online success for an active reseller assignment.
//
// Idempotency: PostgREST insert with resolution=ignore-duplicates. The UNIQUE
// (reseller_id, sim_number_id) constraint means the second+ call for the same
// lifetime inserts zero rows — first write wins, rental_date is preserved.
// A resend therefore never changes or duplicates the rental.
//
// Returns { ok, created, status, error }. Never throws; capture must never
// break the notification hot path.
export async function upsertRental(env, { resellerId, simId, simNumberId, vendor, e164, resellerRentalId, now }) {
  if (resellerId == null || simId == null || simNumberId == null) {
    return { ok: false, created: false, status: 0, error: 'missing key (reseller_id/sim_id/sim_number_id)' };
  }
  const when = now instanceof Date ? now : new Date();
  const row = {
    reseller_id: resellerId,
    sim_id: simId,
    sim_number_id: simNumberId,
    carrier: carrierForVendor(vendor),
    e164: e164 || null,
    reseller_rental_id: resellerRentalId != null ? String(resellerRentalId) : null,
    rental_date: estDateFromDate(when),
    minted_at: when.toISOString(),
  };
  try {
    const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/rentals?on_conflict=reseller_id,sim_number_id`, {
      method: 'POST',
      headers: sbHeaders(env, { Prefer: 'resolution=ignore-duplicates,return=representation' }),
      body: JSON.stringify(row),
    });
    if (!resp.ok) {
      return { ok: false, created: false, status: resp.status, error: await resp.text() };
    }
    const body = await resp.json().catch(() => []);
    const created = Array.isArray(body) && body.length > 0;
    return { ok: true, created, status: resp.status };
  } catch (err) {
    return { ok: false, created: false, status: 0, error: String(err) };
  }
}

// Pick the most recent rental rate active on `day` for `carrier`.
function pickRentalRate(rules, day, carrier) {
  let best = null;
  for (const r of rules) {
    if (r.carrier !== carrier) continue;
    if (r.effective_from > day) continue;
    if (r.effective_to && r.effective_to < day) continue;
    if (!best || r.effective_from > best.effective_from) best = r;
  }
  return best ? parseFloat(best.rate) : null;
}

// Rental-mode billing. One billable unit per rental whose rental_date is in
// [start, end] AND on/after the forward-only cutover. Flat per-carrier rate,
// independent of days or SMS volume. Output shape mirrors
// computeBillingBreakdown so the dashboard/portal can render either engine.
export async function computeRentalBilling(env, { resellerId, start, end, cutover }) {
  const effectiveStart = (start && start > RENTAL_CUTOVER_DATE) ? start : (cutover || RENTAL_CUTOVER_DATE);

  const [resellerArr, mappingArr] = await Promise.all([
    sbGetAll(env, 'resellers?select=id,name&id=eq.' + encodeURIComponent(resellerId)),
    sbGetAll(env, 'qbo_customer_map?select=id,qbo_customer_id,qbo_display_name,daily_rate&reseller_id=eq.' + encodeURIComponent(resellerId)),
  ]);
  const reseller = Array.isArray(resellerArr) && resellerArr[0] ? resellerArr[0] : null;
  const mapping = Array.isArray(mappingArr) && mappingArr[0] ? mappingArr[0] : null;
  const fallbackRate = mapping ? parseFloat(mapping.daily_rate) : 0;

  const rentals = await sbGetAll(env,
    'rentals?select=carrier,rental_date,reseller_rental_id' +
    '&reseller_id=eq.' + encodeURIComponent(resellerId) +
    '&rental_date=gte.' + encodeURIComponent(effectiveStart) +
    '&rental_date=lte.' + encodeURIComponent(end) +
    '&order=rental_date.asc'
  );

  const rules = await sbGetAll(env,
    'reseller_rental_rates?select=carrier,effective_from,effective_to,rate' +
    '&reseller_id=eq.' + encodeURIComponent(resellerId) +
    '&effective_from=lte.' + end +
    '&or=(effective_to.is.null,effective_to.gte.' + effectiveStart + ')'
  );

  // group[date][carrier] = count
  const group = {};
  let missingRate = false;
  for (const r of (Array.isArray(rentals) ? rentals : [])) {
    if (!group[r.rental_date]) group[r.rental_date] = {};
    group[r.rental_date][r.carrier] = (group[r.rental_date][r.carrier] || 0) + 1;
  }

  const days = [];
  for (const date of Object.keys(group).sort()) {
    for (const carrier of Object.keys(group[date]).sort()) {
      const count = group[date][carrier];
      let rate = pickRentalRate(rules, date, carrier);
      if (rate == null) { rate = fallbackRate; missingRate = true; }
      days.push({
        date,
        carrier,
        sim_count: count,
        rate,
        amount: +(count * rate).toFixed(2),
      });
    }
  }

  const totalRentals = days.reduce((s, d) => s + d.sim_count, 0);
  const totalAmount = +(days.reduce((s, d) => s + d.amount, 0)).toFixed(2);

  return {
    reseller_id: resellerId,
    reseller_name: reseller?.name || resellerId,
    billing_mode: 'rental',
    mapping,
    cutover: effectiveStart,
    days,
    total_sim_days: totalRentals, // unit is rentals in this mode
    total_rentals: totalRentals,
    total_amount: totalAmount,
    rules_applied: Array.isArray(rules) && rules.length > 0,
    rate_fallback_used: missingRate,
  };
}
