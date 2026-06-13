// Storefront pure logic — masking, carrier mapping, price fallback, and the
// OTP-highlight formatter shared with public/app.html (sync-commented there).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeToE164,
  vendorToCarrier,
  areaCode,
  maskNumber,
  priceForVendor,
  priceFor,
  DURATION_HOURS,
  durationToHours,
  durationFromHours,
  parseBearerToken,
  escapeHtml,
  highlightOtpHtml,
} from '../src/storefront/logic.mjs';

test('normalizeToE164 matches src/shared/utils.ts behavior', () => {
  assert.equal(normalizeToE164('3475551243'), '+13475551243');
  assert.equal(normalizeToE164('13475551243'), '+13475551243');
  assert.equal(normalizeToE164('+13475551243'), '+13475551243');
  assert.equal(normalizeToE164('(347) 555-1243'), '+13475551243');
  assert.equal(normalizeToE164(''), '');
});

test('vendorToCarrier: teltik is T-Mobile, everything else AT&T', () => {
  assert.equal(vendorToCarrier('teltik'), 'T-Mobile');
  assert.equal(vendorToCarrier('atomic'), 'AT&T');
  assert.equal(vendorToCarrier('helix'), 'AT&T');
  assert.equal(vendorToCarrier('wing_iot'), 'AT&T');
  assert.equal(vendorToCarrier(undefined), 'AT&T');
});

test('maskNumber reveals only area code and last two digits', () => {
  assert.equal(maskNumber('+13475551243'), '(347) •••-••43');
  assert.equal(maskNumber('3475551243'), '(347) •••-••43'); // normalizes first
  assert.equal(maskNumber('+12125550100'), '(212) •••-••00');
  // masked output never contains the middle digits
  assert.equal(maskNumber('+13475551243').includes('555'), false);
  assert.equal(maskNumber('+13475551243').includes('12'), false);
});

test('maskNumber degrades safely on non-US input', () => {
  assert.equal(maskNumber('+447946095812'), '•••12'); // 12 digits, not +1XXXXXXXXXX
  assert.equal(maskNumber(''), '');
  assert.equal(maskNumber(null), '');
});

test('areaCode extracts the first three digits after +1', () => {
  assert.equal(areaCode('+13475551243'), '347');
  assert.equal(areaCode('2125550100'), '212');
  assert.equal(areaCode('+44123'), null);
});

test('priceForVendor: vendor row wins, then default row, then 300', () => {
  const rows = [
    { vendor: 'default', daily_price_cents: 300 },
    { vendor: 'teltik', daily_price_cents: 450 },
  ];
  assert.equal(priceForVendor('teltik', rows), 450);
  assert.equal(priceForVendor('atomic', rows), 300); // falls to default row
  assert.equal(priceForVendor('atomic', [{ vendor: 'default', daily_price_cents: 500 }]), 500);
  assert.equal(priceForVendor('atomic', []), 300); // hard fallback
  assert.equal(priceForVendor('atomic', null), 300);
  // junk price values are skipped
  assert.equal(priceForVendor('teltik', [{ vendor: 'teltik', daily_price_cents: 'nope' }]), 300);
  assert.equal(priceForVendor('teltik', [{ vendor: 'teltik', daily_price_cents: 0 }]), 300);
});

// ---- durations + per-duration pricing ---------------------------------------

test('durationToHours maps the public API vocabulary', () => {
  assert.equal(durationToHours('day'), 24);
  assert.equal(durationToHours('week'), 168);
  assert.equal(durationToHours('month'), 720);
  assert.deepEqual(DURATION_HOURS, { day: 24, week: 168, month: 720 });
});

test('durationToHours rejects everything else with null', () => {
  assert.equal(durationToHours('year'), null);
  assert.equal(durationToHours('DAY'), null);
  assert.equal(durationToHours(''), null);
  assert.equal(durationToHours(undefined), null);
  assert.equal(durationToHours(24), null);
  // prototype pollution guard: inherited keys are not durations
  assert.equal(durationToHours('toString'), null);
  assert.equal(durationToHours('constructor'), null);
});

test('durationFromHours derives the label from the rental window', () => {
  assert.equal(durationFromHours(24), 'day');
  assert.equal(durationFromHours(168), 'week');
  assert.equal(durationFromHours(720), 'month');
  // boundaries and slop (ends_at - starts_at can be off by ms)
  assert.equal(durationFromHours(167), 'day');
  assert.equal(durationFromHours(167.9997), 'week'); // rounds to 168
  assert.equal(durationFromHours(719), 'week');
  assert.equal(durationFromHours(719.9997), 'month');
  assert.equal(durationFromHours(800), 'month');
  assert.equal(durationFromHours(NaN), 'day');
  assert.equal(durationFromHours(undefined), 'day');
});

test('priceFor: full vendor row wins for every duration', () => {
  const rows = [
    { vendor: 'default', daily_price_cents: 300, weekly_price_cents: 1500, monthly_price_cents: 4500 },
    { vendor: 'teltik', daily_price_cents: 450, weekly_price_cents: 2000, monthly_price_cents: 6000 },
  ];
  assert.equal(priceFor('teltik', 'day', rows), 450);
  assert.equal(priceFor('teltik', 'week', rows), 2000);
  assert.equal(priceFor('teltik', 'month', rows), 6000);
});

test('priceFor: NULL vendor columns fall back to the default row per-column', () => {
  const rows = [
    { vendor: 'default', daily_price_cents: 300, weekly_price_cents: 1500, monthly_price_cents: 4500 },
    { vendor: 'atomic', daily_price_cents: 400, weekly_price_cents: null, monthly_price_cents: null },
  ];
  assert.equal(priceFor('atomic', 'day', rows), 400);   // own column
  assert.equal(priceFor('atomic', 'week', rows), 1500); // default column
  assert.equal(priceFor('atomic', 'month', rows), 4500);
});

test('priceFor: still-null week/month derive from the daily price (x7 / x28)', () => {
  // default row predates the duration columns: weekly/monthly are NULL
  const rows = [
    { vendor: 'default', daily_price_cents: 300, weekly_price_cents: null, monthly_price_cents: null },
    { vendor: 'teltik', daily_price_cents: 450 },
  ];
  assert.equal(priceFor('teltik', 'week', rows), 450 * 7);
  assert.equal(priceFor('teltik', 'month', rows), 450 * 28);
  assert.equal(priceFor('atomic', 'week', rows), 300 * 7);   // daily via default
  assert.equal(priceFor('atomic', 'month', rows), 300 * 28);
});

test('priceFor: empty/junk tables bottom out at the hard daily fallback', () => {
  assert.equal(priceFor('atomic', 'day', []), 300);
  assert.equal(priceFor('atomic', 'week', []), 300 * 7);
  assert.equal(priceFor('atomic', 'month', null), 300 * 28);
  // zero / non-numeric column values are skipped, not used
  const junk = [{ vendor: 'teltik', daily_price_cents: 450, weekly_price_cents: 0, monthly_price_cents: 'nope' }];
  assert.equal(priceFor('teltik', 'week', junk), 450 * 7);
  assert.equal(priceFor('teltik', 'month', junk), 450 * 28);
});

test('priceFor: unknown durations return null (route must 400)', () => {
  const rows = [{ vendor: 'default', daily_price_cents: 300 }];
  assert.equal(priceFor('teltik', 'year', rows), null);
  assert.equal(priceFor('teltik', '', rows), null);
  assert.equal(priceFor('teltik', undefined, rows), null);
});

test('priceForVendor stays the daily alias (back-compat)', () => {
  const rows = [
    { vendor: 'default', daily_price_cents: 300 },
    { vendor: 'teltik', daily_price_cents: 450 },
  ];
  assert.equal(priceForVendor('teltik', rows), priceFor('teltik', 'day', rows));
  assert.equal(priceForVendor('atomic', rows), 300);
});

// ---- bearer-token header parsing ---------------------------------------------

test('parseBearerToken extracts a hex api_token', () => {
  const tok = 'a'.repeat(32);
  assert.equal(parseBearerToken('Bearer ' + tok), tok);
  assert.equal(parseBearerToken('  Bearer ' + tok + '  '), tok); // tolerant of padding
  assert.equal(parseBearerToken('Bearer   ' + tok), tok);        // multiple spaces
});

test('parseBearerToken lowercases uppercase hex (tokens are stored lowercase)', () => {
  assert.equal(parseBearerToken('Bearer ABCDEF0123456789ABCDEF0123456789'),
    'abcdef0123456789abcdef0123456789');
});

test('parseBearerToken rejects non-bearer and malformed values', () => {
  assert.equal(parseBearerToken(null), null);
  assert.equal(parseBearerToken(''), null);
  assert.equal(parseBearerToken('Bearer'), null);
  assert.equal(parseBearerToken('Bearer '), null);
  assert.equal(parseBearerToken('Basic dXNlcjpwYXNz'), null);
  assert.equal(parseBearerToken('bearer ' + 'a'.repeat(32)), null); // scheme is case-sensitive
  assert.equal(parseBearerToken('Bearer not-hex-at-all!'), null);
  assert.equal(parseBearerToken('Bearer abc'), null);               // too short
  assert.equal(parseBearerToken('Bearer ' + 'a'.repeat(200)), null); // absurdly long
  assert.equal(parseBearerToken('Bearer ' + 'a'.repeat(32) + ' extra'), null);
});

test('highlightOtpHtml marks 4-8 digit standalone codes', () => {
  assert.equal(
    highlightOtpHtml('Your code is 482913'),
    'Your code is <mark>482913</mark>'
  );
  assert.equal(highlightOtpHtml('PIN: 1234'), 'PIN: <mark>1234</mark>');
  assert.equal(highlightOtpHtml('code 12345678 expires soon'),
    'code <mark>12345678</mark> expires soon');
});

test('highlightOtpHtml ignores too-short and too-long digit runs', () => {
  assert.equal(highlightOtpHtml('call 911 now'), 'call 911 now');
  assert.equal(highlightOtpHtml('ref 1234567890'), 'ref 1234567890'); // 10 digits: not an OTP
});

test('highlightOtpHtml escapes HTML before marking', () => {
  const out = highlightOtpHtml('<b>code</b> 5566 & more');
  assert.equal(out, '&lt;b&gt;code&lt;/b&gt; <mark>5566</mark> &amp; more');
});

test('highlightOtpHtml handles multiple codes and null body', () => {
  assert.equal(
    highlightOtpHtml('use 1111 or 2222'),
    'use <mark>1111</mark> or <mark>2222</mark>'
  );
  assert.equal(highlightOtpHtml(null), '');
});

test('escapeHtml escapes all five specials', () => {
  assert.equal(escapeHtml(`<a href="x" data-y='z'>&</a>`),
    '&lt;a href=&quot;x&quot; data-y=&#39;z&#39;&gt;&amp;&lt;/a&gt;');
});
