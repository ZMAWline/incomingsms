// The QBO CSV download buttons must not override the Worker's separator-free
// filename (#84) with an underscored one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../src/dashboard/public/index.html', import.meta.url), 'utf8');

test('no invoice download builds an underscored filename', () => {
  assert.ok(!/invoice_\$\{/.test(html));
  assert.ok(!/a\.download = `invoice_/.test(html));
});

test('invoiceDownloadName prefers the server filename, else a separator-free fallback', () => {
  const src = html.match(/function invoiceDownloadName\(resp, fallback\) \{[\s\S]*?\n        \}/)[0];
  const ctx = {};
  vm.runInNewContext(src + '; this.fn = invoiceDownloadName;', ctx);
  const resp = (cd) => ({ headers: { get: () => cd } });
  assert.equal(ctx.fn(resp('attachment; filename="invoiceAcme2026091420260920.csv"'), 'x.csv'), 'invoiceAcme2026091420260920.csv');
  assert.equal(ctx.fn(resp(null), 'invoice12.csv'), 'invoice12.csv');
});
