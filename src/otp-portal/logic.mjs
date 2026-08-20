// Pure OTP-portal logic — no I/O. Same split as src/storefront/logic.mjs:
// the worker (index.js) owns routing + Supabase I/O; this file holds
// anything testable without a live DB.

export function normalizeToE164(to) {
  const s = String(to || '');
  const digits = s.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (s.startsWith('+')) return s;
  return s;
}

export function vendorToCarrier(vendor) {
  return vendor === 'teltik' ? 'T-Mobile' : 'AT&T';
}

// Sims eligible for a fresh OTP-portal assignment: in shop_pool ∩
// sims.status='active' ∩ has a current e164 ∩ NOT rented by a paying
// storefront customer ∩ NOT already held by another unexpired otp-portal
// assignment. Same shape as storefront's availableSims() in index.js, plus
// the otp_portal_assignments exclusion this worker owns.
export function computeAvailableCandidates({ sims, numbers, activeShopRentals, activeAssignments }) {
  const numberBySim = new Map((numbers || []).map((n) => [n.sim_id, n.e164]));
  const rentedSims = new Set((activeShopRentals || []).map((r) => r.sim_id));
  const heldSims = new Set((activeAssignments || []).map((a) => a.sim_id));
  const out = [];
  for (const sim of sims || []) {
    if (rentedSims.has(sim.id) || heldSims.has(sim.id)) continue;
    const e164 = numberBySim.get(sim.id);
    if (!e164) continue;
    out.push({ sim_id: sim.id, vendor: sim.vendor, e164: normalizeToE164(e164) });
  }
  return out;
}

// Injectable RNG (defaults to Math.random) so picks are deterministic in tests.
export function pickRandom(candidates, rng = Math.random) {
  if (!candidates || candidates.length === 0) return null;
  const idx = Math.min(Math.floor(rng() * candidates.length), candidates.length - 1);
  return candidates[idx];
}

// Message scope: same sim, same e164 the assignment was made for, received
// at or after assignment time. Assignment time (not "SIM's whole history")
// is the point — a link recipient should never see a stranger's earlier OTPs
// that landed on this recycled number before it was assigned to them.
export function filterAssignmentMessages(messages, { e164, assignedAtMs }) {
  const target = normalizeToE164(e164);
  return (messages || [])
    .filter((m) => normalizeToE164(m.to_number) === target)
    .filter((m) => Date.parse(m.received_at) >= assignedAtMs)
    .map((m) => ({ from_number: m.from_number, body: m.body, received_at: m.received_at }));
}

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Highlight likely OTP codes (standalone 4-8 digit runs) in an SMS body.
// Keep in sync with the duplicate inline in the page's <script> in index.js.
export const OTP_CODE_RE = /\b\d{4,8}\b/g;

export function highlightOtpHtml(body) {
  return escapeHtml(body).replace(OTP_CODE_RE, (m) => `<mark>${m}</mark>`);
}
