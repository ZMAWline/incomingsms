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

// Price lookup against shop_prices rows [{vendor, daily_price_cents}]:
// exact vendor row → 'default' row → hard fallback 300.
export function priceForVendor(vendor, priceRows) {
  const rows = Array.isArray(priceRows) ? priceRows : [];
  const pick = (v) => {
    const r = rows.find((x) => x && x.vendor === v);
    const n = r ? Number(r.daily_price_cents) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  return pick(vendor) ?? pick('default') ?? 300;
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
