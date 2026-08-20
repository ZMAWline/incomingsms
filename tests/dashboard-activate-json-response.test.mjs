// Regression test: a non-2xx from /activate (auth failure, Cloudflare edge
// error, worker exception) can return a plain-text/HTML body instead of JSON.
// activateSims() used to call response.json() unconditionally, so that case
// threw a raw "Unexpected token" SyntaxError that surfaced to the operator as
// a generic, unhelpful "something about json" toast with no real error
// message and no indication of what to do next.
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
vm.runInContext(grabFn('parseApiResponseText'), ctx);
const { parseApiResponseText } = ctx;

test('parseApiResponseText parses a normal JSON body', () => {
  const r = parseApiResponseText('{"ok":true,"queued":3}');
  assert.equal(r.ok, true);
  assert.equal(r.data.ok, true);
  assert.equal(r.data.queued, 3);
});

test('parseApiResponseText reports failure instead of throwing on plain-text bodies', () => {
  // e.g. the pre-fix bulk-activator auth-failure response body.
  assert.doesNotThrow(() => parseApiResponseText('Unauthorized'));
  const r = parseApiResponseText('Unauthorized');
  assert.equal(r.ok, false);
  assert.equal(r.data, null);
});

test('parseApiResponseText reports failure instead of throwing on HTML edge-error bodies', () => {
  const r = parseApiResponseText('<html><body>502 Bad Gateway</body></html>');
  assert.equal(r.ok, false);
});

test('parseApiResponseText reports failure on an empty body', () => {
  const r = parseApiResponseText('');
  assert.equal(r.ok, false);
});
