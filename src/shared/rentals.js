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

// Pick the volume-tier rate for `count` from a legacy reseller_rates rule's tiers.
function tierRate(tiers, count) {
  if (!Array.isArray(tiers)) return null;
  const sorted = [...tiers].sort((a, b) => (Number(a.min_count) || 0) - (Number(b.min_count) || 0));
  for (const t of sorted) {
    const min = Number(t.min_count) || 0;
    const max = (t.max_count == null || t.max_count === '') ? Infinity : Number(t.max_count);
    if (count >= min && count <= max) return parseFloat(t.rate);
  }
  return null;
}

// Most-recent legacy reseller_rates rule active on `day` for a vendor scope
// (null = the "all AT&T" rule). Mirrors billing.js pickActiveRuleForScope.
function pickTierRule(rules, day, vendor) {
  let best = null;
  for (const r of rules) {
    if ((r.vendor || null) !== vendor) continue;
    if (r.effective_from > day) continue;
    if (r.effective_to && r.effective_to < day) continue;
    if (!best || r.effective_from > best.effective_from) best = r;
  }
  return best;
}

// Rental-mode billing. One billable unit per rental whose rental_date is in
// [start, end] AND on/after the forward-only cutover. Flat per-carrier rate,
// independent of days or SMS volume. Output shape mirrors
// computeBillingBreakdown so the dashboard/portal can render either engine.
export async function computeRentalBilling(env, { resellerId, start, end, cutover }) {
  // No forward-only clamp: the preview/calculator bills exactly the requested
  // [start, end] window, so any date range can be run and compared against the
  // legacy engine. The cutover is an operational choice — we simply don't
  // re-issue already-agreed invoices — not a limit on what the engine computes.
  // (`cutover` kept for signature/back-compat; RENTAL_CUTOVER_DATE only a fallback
  // if no start is supplied.)
  const effectiveStart = start || cutover || RENTAL_CUTOVER_DATE;

  const [resellerArr, mappingArr] = await Promise.all([
    sbGetAll(env, 'resellers?select=id,name&id=eq.' + encodeURIComponent(resellerId)),
    sbGetAll(env, 'qbo_customer_map?select=id,qbo_customer_id,qbo_display_name,daily_rate&reseller_id=eq.' + encodeURIComponent(resellerId)),
  ]);
  const reseller = Array.isArray(resellerArr) && resellerArr[0] ? resellerArr[0] : null;
  const mapping = Array.isArray(mappingArr) && mappingArr[0] ? mappingArr[0] : null;
  const fallbackRate = mapping ? parseFloat(mapping.daily_rate) : 0;

  const rentals = await sbGetAll(env,
    'rentals?select=carrier,rental_date,reseller_rental_id,sim_number_id' +
    '&reseller_id=eq.' + encodeURIComponent(resellerId) +
    '&rental_date=gte.' + encodeURIComponent(effectiveStart) +
    '&rental_date=lte.' + encodeURIComponent(end) +
    '&order=rental_date.asc'
  );

  // Flat per-carrier rental rates (fallback when no volume tier matches).
  const flatRules = await sbGetAll(env,
    'reseller_rental_rates?select=carrier,effective_from,effective_to,rate' +
    '&reseller_id=eq.' + encodeURIComponent(resellerId) +
    '&effective_from=lte.' + end +
    '&or=(effective_to.is.null,effective_to.gte.' + effectiveStart + ')'
  );

  // Volume-pricing tiers live in the legacy reseller_rates table (vendor-scoped).
  // Rental mode honors them keyed on the carrier's TOTAL billed rentals in the
  // window — e.g. "total tmobile rentals > 3000 → $1.55/block". tmobile maps to
  // the 'teltik' scope; att to the all-att (vendor=null) scope.
  const tierRules = await sbGetAll(env,
    'reseller_rates?select=vendor,effective_from,effective_to,tiers' +
    '&reseller_id=eq.' + encodeURIComponent(resellerId) +
    '&effective_from=lte.' + end +
    '&or=(effective_to.is.null,effective_to.gte.' + effectiveStart + ')'
  );

  // Bad-rental exclusion: a lifetime reported defective and NOT resolved on the
  // same EST day it was reported is not billable. received_at can't precede the
  // rental, so the window's own start bounds the fetch.
  const reports = await sbGetAll(env,
    'rental_reports?select=sim_number_id,received_at,closed_at' +
    '&reseller_id=eq.' + encodeURIComponent(resellerId) +
    '&sim_number_id=not.is.null' +
    '&received_at=gte.' + encodeURIComponent(effectiveStart)
  );
  const excludedLifetimes = new Set();
  for (const rep of (Array.isArray(reports) ? reports : [])) {
    if (rep.sim_number_id == null) continue;
    const recDay = estDateFromDate(new Date(rep.received_at));
    const resolvedSameDay = rep.closed_at && estDateFromDate(new Date(rep.closed_at)) === recDay;
    if (!resolvedSameDay) excludedLifetimes.add(rep.sim_number_id);
  }

  // group[date][carrier] = count; carrierTotal drives the volume tier.
  const group = {};
  const carrierTotal = {};
  let withTrustotpId = 0;
  let withoutTrustotpId = 0;
  let excludedBad = 0;
  for (const r of (Array.isArray(rentals) ? rentals : [])) {
    if (r.sim_number_id != null && excludedLifetimes.has(r.sim_number_id)) { excludedBad++; continue; }
    if (!group[r.rental_date]) group[r.rental_date] = {};
    group[r.rental_date][r.carrier] = (group[r.rental_date][r.carrier] || 0) + 1;
    carrierTotal[r.carrier] = (carrierTotal[r.carrier] || 0) + 1;
    if (r.reseller_rental_id) withTrustotpId++; else withoutTrustotpId++;
  }

  // Resolve the rate per (date, carrier): volume tier (legacy reseller_rates,
  // keyed on the carrier's WINDOW-TOTAL count) → flat reseller_rental_rate
  // effective on that date → daily_rate fallback. Per-date resolution preserves
  // mid-window flat-rate changes; the tier uses the window total so a rule like
  // "total tmobile rentals > 3000 → 1.55" holds across every day of the window.
  const VENDOR_SCOPE = { tmobile: 'teltik', att: null };
  let missingRate = false;
  let rulesApplied = false;
  const days = [];
  for (const date of Object.keys(group).sort()) {
    for (const carrier of Object.keys(group[date]).sort()) {
      const count = group[date][carrier];
      const total = carrierTotal[carrier];
      let rate = null;
      const tierRule = pickTierRule(tierRules, date, carrier in VENDOR_SCOPE ? VENDOR_SCOPE[carrier] : null);
      if (tierRule) {
        const tr = tierRate(tierRule.tiers, total);
        if (tr != null) { rate = tr; rulesApplied = true; }
      }
      if (rate == null) {
        const fr = pickRentalRate(flatRules, date, carrier);
        if (fr != null) { rate = fr; rulesApplied = true; }
      }
      if (rate == null) { rate = fallbackRate; missingRate = true; }
      days.push({ date, carrier, sim_count: count, rate, amount: +(count * rate).toFixed(2) });
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
    // Authoritative count = rentals matched to a TrustOTP 'Rental created' rentalId.
    total_with_trustotp_id: withTrustotpId,
    total_without_trustotp_id: withoutTrustotpId,
    // Lifetimes excluded because they were reported bad and not resolved same-day.
    excluded_bad_rentals: excludedBad,
    rules_applied: rulesApplied,
    rate_fallback_used: missingRate,
  };
}
