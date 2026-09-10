// The dashboard never uses a native browser dialog.
//
// alert() / confirm() / prompt() render the browser's own chrome — its font,
// its colours, and the origin as a header ("dashboard-test.zalmen-531.workers.dev
// says"). That reads as a security warning, cannot be themed, and breaks the
// design. Every one of them has an in-page equivalent:
//
//   alert(msg)        -> showToast(msg, 'error')
//   confirm(msg)      -> await showConfirm(title, msg)
//   prompt(msg)       -> await showTextPrompt(title, msg, default, placeholder)
//
// This test is the guard. If it fails, use the helper, do not add an exception.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILES = [
  'src/dashboard/public/index.html',
  'src/dashboard/auth-pages.mjs',
];

// A call, not a property access (foo.alert) or a longer identifier
// (showConfirm, myPrompt). Comments and strings are stripped first so prose
// mentioning the rule does not trip it.
const CALL = /(^|[^.\w$])(alert|confirm|prompt)\s*\(/;

function stripCommentsAndStrings(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``');
}

for (const rel of FILES) {
  test(rel + ' contains no native browser dialogs', () => {
    const src = stripCommentsAndStrings(fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'));
    const offenders = src
      .split('\n')
      .map((line, i) => [i + 1, line])
      .filter(([, line]) => CALL.test(line));

    assert.deepStrictEqual(
      offenders.map(([n, line]) => n + ': ' + line.trim().slice(0, 90)),
      [],
      'use showToast / showConfirm / showTextPrompt instead of a native dialog'
    );
  });
}

test('the in-page replacements all exist', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/dashboard/public/index.html'), 'utf8');
  for (const fn of ['function showToast', 'function showConfirm', 'function showTextPrompt', 'function showAdHocConfirm']) {
    assert.ok(html.includes(fn), fn + ' must exist for callers to use');
  }
});

test('showConfirm degrades to an in-page overlay, not a native confirm', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/dashboard/public/index.html'), 'utf8');
  const fn = html.slice(html.indexOf('function showConfirm('));
  const body = fn.slice(0, fn.indexOf('\n        }'));
  assert.match(body, /showAdHocConfirm/, 'the missing-modal path must build an overlay');
});
