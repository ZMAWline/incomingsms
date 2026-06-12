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
