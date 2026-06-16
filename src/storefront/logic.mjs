// Pure storefront helpers, shared by the worker (index.js) and the tests
// (tests/storefront-logic.test.mjs). No I/O here.

// Keep in sync with normalizeToE164 in src/shared/utils.ts (that file is
// TypeScript, which node:test can't import directly under this package).
export function normalizeToE164(to) {
  const s = String(to || '');
  const digits = s.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (s.startsWith('+')) return s;
  return s;
}

// Storefront-facing carrier label. teltik rides T-Mobile; every other vendor
// in the fleet (atomic / helix / wing_iot) is AT&T.
export function vendorToCarrier(vendor) {
  return vendor === 'teltik' ? 'T-Mobile' : 'AT&T';
}

export function areaCode(e164) {
  const m = normalizeToE164(e164).match(/^\+1(\d{10})$/);
  return m ? m[1].slice(0, 3) : null;
}

// '(347) •••-••43' — reveal area code + last two digits only.
export function maskNumber(e164) {
  const m = normalizeToE164(e164).match(/^\+1(\d{10})$/);
  if (!m) {
    const d = String(e164 || '').replace(/\D/g, '');
    return d.length >= 2 ? `•••${d.slice(-2)}` : '';
  }
  const ten = m[1];
  return `(${ten.slice(0, 3)}) •••-••${ten.slice(8)}`;
}

// Rental durations. Hours feed shop_claim_rental's p_hours; the labels are
// the public API vocabulary (POST /api/rent { duration }).
export const DURATION_HOURS = { day: 24, week: 168, month: 720 };

export function durationToHours(duration) {
  return Object.prototype.hasOwnProperty.call(DURATION_HOURS, duration)
    ? DURATION_HOURS[duration]
    : null;
}

// Reverse mapping for existing rentals: shop_rentals has no duration column,
// so the label is derived from the window length (ends_at - starts_at).
export function durationFromHours(hours) {
  const h = Math.round(Number(hours));
  if (!Number.isFinite(h)) return 'day';
  if (h >= DURATION_HOURS.month) return 'month';
  if (h >= DURATION_HOURS.week) return 'week';
  return 'day';
}

const DURATION_COLUMNS = {
  day: 'daily_price_cents',
  week: 'weekly_price_cents',
  month: 'monthly_price_cents',
};

// Price lookup against shop_prices rows
// [{vendor, daily_price_cents, weekly_price_cents, monthly_price_cents}].
// Per-column fallback chain: exact vendor row → 'default' row → derived from
// the daily price (x7 for week, x28 for month) → hard daily fallback 300.
// Vendor rows may carry NULLs in any column; each duration falls back
// independently. Unknown durations return null (callers must 400).
export function priceFor(vendor, duration, priceRows) {
  const col = DURATION_COLUMNS[duration];
  if (!col) return null;
  const rows = Array.isArray(priceRows) ? priceRows : [];
  const pick = (v) => {
    const r = rows.find((x) => x && x.vendor === v);
    const n = r ? Number(r[col]) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const direct = pick(vendor) ?? pick('default');
  if (direct != null) return direct;
  if (duration === 'day') return 300; // hard fallback
  const daily = priceFor(vendor, 'day', rows);
  return duration === 'week' ? daily * 7 : daily * 28;
}

// Back-compat daily lookup (original storefront API).
export function priceForVendor(vendor, priceRows) {
  return priceFor(vendor, 'day', priceRows);
}

// Extract an api_token from an Authorization header value. Accepts only
// 'Bearer <hex>' (shop_customers.api_token is lowercase hex; we tolerate
// uppercase input). Anything else — wrong scheme, junk, empty — is null.
export function parseBearerToken(headerValue) {
  const m = /^Bearer\s+([0-9a-fA-F]{16,128})$/.exec(String(headerValue || '').trim());
  return m ? m[1].toLowerCase() : null;
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
// Returns HTML-escaped text with <mark> around each code.
// Keep in sync with the duplicate in public/app.html.
export const OTP_CODE_RE = /\b\d{4,8}\b/g;

export function highlightOtpHtml(body) {
  return escapeHtml(body).replace(OTP_CODE_RE, (m) => `<mark>${m}</mark>`);
}
