// Every Postgres function a worker calls must be defined in a migration file.
//
// Why: on 2026-09-18 an audit found EIGHT functions that PROD was running and
// that no file in this repo defined — claim_rotation_slot (the atomic gate that
// stops two workers rotating the same SIM), teltik_hold_morning_batch,
// list_zips_needing_refill, attempts_today, get_ledger_months,
// get_sms_counts_24h, rotation_freshness, and a drifted increment_rotation_fail.
// They existed only inside the live database. A rebuild would have lost them
// silently, and nobody could review code that wasn't in the repo.
//
// This test scans src/ for RPC call sites and migrations/ + supabase/migrations/
// for CREATE FUNCTION statements, and fails if a name is called but never
// defined. It reads source text only — no database connection.

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname;

function walk(dir, exts, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, exts, out);
    else if (exts.some(e => name.endsWith(e))) out.push(full);
  }
  return out;
}

// Call shapes in this codebase:
//   supabaseRpc(env, 'name', {...})          workers
//   fetch(`${env.SUPABASE_URL}/rest/v1/rpc/name`, ...)
//   callRpc('rpc/name', ...)                 dashboard
const CALL_PATTERNS = [
  /\/rest\/v1\/rpc\/([a-z][a-z0-9_]*)/g,
  /supabaseRpc\(\s*[A-Za-z0-9_.]+\s*,\s*['"`]([a-z][a-z0-9_]*)['"`]/g,
  /callRpc\(\s*['"`]rpc\/([a-z][a-z0-9_]*)['"`]/g,
];

function calledRpcNames() {
  const found = new Map(); // name -> first "file:line" that calls it
  for (const file of walk(join(ROOT, 'src'), ['.js', '.mjs', '.ts'])) {
    const text = readFileSync(file, 'utf8');
    for (const rx of CALL_PATTERNS) {
      rx.lastIndex = 0;
      let m;
      while ((m = rx.exec(text)) !== null) {
        if (found.has(m[1])) continue;
        const line = text.slice(0, m.index).split('\n').length;
        found.set(m[1], `${file.slice(ROOT.length)}:${line}`);
      }
    }
  }
  return found;
}

function definedFunctionNames() {
  const defined = new Map(); // name -> file that defines it
  const dirs = [join(ROOT, 'migrations'), join(ROOT, 'supabase', 'migrations')];
  // `create [or replace] function [public.]name(`
  const rx = /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z][a-z0-9_]*)\s*\(/gi;
  for (const dir of dirs) {
    for (const file of walk(dir, ['.sql'])) {
      const text = readFileSync(file, 'utf8');
      rx.lastIndex = 0;
      let m;
      while ((m = rx.exec(text)) !== null) {
        const name = m[1].toLowerCase();
        if (!defined.has(name)) defined.set(name, file.slice(ROOT.length));
      }
    }
  }
  return defined;
}

test('every RPC the workers call is defined in a migration file', () => {
  const called = calledRpcNames();
  const defined = definedFunctionNames();

  assert.ok(called.size > 0, 'found no RPC call sites at all — the scanner regexes are broken');

  const missing = [...called.entries()]
    .filter(([name]) => !defined.has(name))
    .map(([name, where]) => `  ${name}  (called at ${where})`);

  assert.deepEqual(missing, [],
    'These functions are called but defined nowhere in migrations/ or supabase/migrations/.\n' +
    'Capture the live definition with pg_get_functiondef() and add a migration:\n' +
    missing.join('\n'));
});

test('the eight functions captured from PROD on 2026-09-18 stay in the repo', () => {
  // A regression guard with names spelled out, so deleting a capture file fails
  // here even if someone also deletes the call site in the same change.
  const defined = definedFunctionNames();
  for (const name of [
    'claim_rotation_slot',
    'teltik_hold_morning_batch',
    'list_zips_needing_refill',
    'attempts_today',
    'get_ledger_months',
    'get_sms_counts_24h',
    'rotation_freshness',
    'increment_rotation_fail',
  ]) {
    assert.ok(defined.has(name), `${name} lost its migration file`);
  }
});
