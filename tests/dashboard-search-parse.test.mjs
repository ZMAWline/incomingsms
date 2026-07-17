// Behavior check for dashboard search parsing: pasted ID lists split on any
// whitespace/comma/semicolon into OR terms; free-text phrases with spaces stay
// a single substring term. Functions are extracted from the real frontend
// (src/dashboard/public/index.html) so the test exercises shipped code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../src/dashboard/public/index.html', import.meta.url), 'utf8');

function grabFn(name) {
  const s = html.indexOf('function ' + name + '(');
  assert.notEqual(s, -1, name + ' not found in index.html');
  let d = 0, j = s, started = false;
  while (j < html.length) {
    if (html[j] === '{') { d++; started = true; }
    if (html[j] === '}') { if (--d === 0 && started) break; }
    j++;
  }
  return html.slice(s, j + 1);
}

const ctx = vm.createContext({});
vm.runInContext(grabFn('matchesSearch') + ';' + grabFn('normalizePastedSearch'), ctx);
const { matchesSearch, normalizePastedSearch } = ctx;

const sim = { iccid: '8901260123456789012', mdn: '5551234567', label: 'John Smith test line' };
const other = { iccid: '8901260999999999999', mdn: '5559999999', label: 'other' };

test('matchesSearch splits pasted ID lists on any separator', () => {
  assert.ok(matchesSearch(sim, '8901260123456789012 8901260888888888888'), 'space-separated ID list');
  assert.ok(matchesSearch(sim, '8901260123456789012\t5550001111'), 'tab-separated ID list');
  assert.ok(matchesSearch(sim, '111111 \n 8901260123456789012'), 'mixed newline/space list');
  assert.ok(matchesSearch(sim, '8901260123456789012,5550001111;123456'), 'comma/semicolon list');
  assert.ok(!matchesSearch(other, '8901260123456789012 5551234567'), 'non-matching object excluded');
});

test('matchesSearch keeps free-text phrases as one substring term', () => {
  assert.ok(matchesSearch(sim, 'john smith'), 'free text phrase matches');
  assert.ok(!matchesSearch(other, 'john smith'), 'free text phrase not split into OR terms');
});

function paste(text, initial) {
  const el = { value: initial || '', selectionStart: (initial || '').length, selectionEnd: (initial || '').length };
  let prevented = false, cbCalled = false;
  const e = { clipboardData: { getData: () => text }, preventDefault: () => { prevented = true; } };
  normalizePastedSearch(el, e, () => { cbCalled = true; });
  return { el, prevented, cbCalled };
}

test('normalizePastedSearch normalizes ID lists, leaves free text alone', () => {
  assert.equal(paste('8901 8902 8903').prevented, false, 'short tokens: not treated as ID list');
  let r = paste('8901260123456789012 8901260999999999999');
  assert.ok(r.prevented && r.cbCalled, 'space list normalized');
  assert.equal(r.el.value, '8901260123456789012,8901260999999999999', 'space list joined with commas');
  r = paste('8901260123456789012\r\n8901260999999999999\n5551234567');
  assert.equal(r.el.value, '8901260123456789012,8901260999999999999,5551234567', 'multiline joined');
  r = paste('8901260123456789012\t8901260999999999999');
  assert.equal(r.el.value, '8901260123456789012,8901260999999999999', 'tabs joined');
  r = paste('hello world');
  assert.ok(!r.prevented, 'plain free text paste untouched');
  r = paste('  8901260123456789012 , 8901260999999999999 ; 5551234567  ');
  assert.equal(r.el.value, '8901260123456789012,8901260999999999999,5551234567', 'mixed separators + padding');
});
