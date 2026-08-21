// Regression test: the Change IMEI modal's front-end validation used the regex
// /^d{15}$/ (missing the backslash on \d), which matches a literal run of 15
// "d" characters and therefore rejects every real IMEI. That blocked operators
// from ever submitting a manual IMEI change, independent of any backend
// gateway-host logic. Reads the shipped source directly (not a DOM/vm
// extraction, since these checks live inline in DOM-heavy handlers) so this
// test fails again if the typo comes back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../src/dashboard/public/index.html', import.meta.url), 'utf8');

test('Change IMEI validation regexes require \\d{15}, not the literal string "d" x15', () => {
  const badPattern = /\/\^d\{15\}\$\//;
  assert.equal(badPattern.test(html), false, 'found the unescaped /^d{15}$/ IMEI-validation typo in index.html');

  const goodPattern = /\/\^\\d\{15\}\$\//g;
  const matches = html.match(goodPattern) || [];
  // checkManualImeiEligibility, confirmChangeImei (manual path), and the bulk
  // "Modify IMEI" modal all validate a manually entered IMEI.
  assert.ok(matches.length >= 3, `expected at least 3 correct /^\\d{15}$/ IMEI validations, found ${matches.length}`);
});

test('the fixed regex actually accepts a real 15-digit IMEI and rejects junk', () => {
  const validate = /^\d{15}$/;
  assert.equal(validate.test('351756051523999'), true);
  assert.equal(validate.test('12345'), false);
  assert.equal(validate.test('35175605152399900'), false);
  assert.equal(validate.test('35175605152399a'), false);
});
