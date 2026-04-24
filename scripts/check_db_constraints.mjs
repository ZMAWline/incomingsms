#!/usr/bin/env node
// Drift guard — compares string literals written to enum-like DB columns
// against the Postgres CHECK constraint allowlists. Fails non-zero on drift.
//
// Why this exists: two incidents on 2026-04-24 hit the same class of bug —
// code wrote `rotation_status='mdn_pending'` and later `status='rotation_failed'`
// but neither value was in the column's CHECK constraint. The first caused
// ~1,020 Wing IoT MDN burns; the second silently broke the 3-strikes rotation
// cap for months (RPC transactions rolled back every time count would hit 3).
//
// To add a new guarded column, append to `COLUMNS` below with its column name,
// the allowed-values set (MUST match the live CHECK constraint exactly), and
// any columns whose literals look similar to this one but should be ignored
// (to cut down false positives — e.g. `request_body: { rotation_status: ... }`
// inside a log-shape object where values are echoes of API responses).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('../src/', import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, '$1');

/** @type {{column: string, allowed: Set<string>, constraint: string}[]} */
const COLUMNS = [
  {
    column: 'rotation_status',
    constraint: 'check_rotation_status',
    allowed: new Set(['ready', 'rotating', 'success', 'failed', 'mdn_pending']),
  },
  {
    column: 'status',
    constraint: 'sims_status_check',
    allowed: new Set([
      'pending', 'provisioning', 'active', 'suspended', 'canceled',
      'error', 'data_mismatch', 'helix_timeout', 'rotation_failed',
    ]),
  },
  {
    column: 'rotation_source',
    constraint: 'check_rotation_source',
    allowed: new Set(['auto', 'manual']),
  },
];

function makeRx(column) {
  // Matches:   column: 'value'    column = 'value'    'column': 'value'
  // The negative lookbehind `(?<![A-Za-z0-9_])` ensures we don't match the
  // column name as a suffix of another identifier — e.g. `rotation_status`
  // or `attStatus` must NOT trigger the `status` column check.
  return new RegExp(`(?<![A-Za-z0-9_])${column}['"]?\\s*[:=]\\s*['"]([^'"]+)['"]`, 'g');
}

// Only flag a `status` literal if the surrounding ~400 chars reference the
// `sims` table — otherwise it's probably imei_pool.status, webhook_deliveries.status,
// api_logs.status, or a carrier API response echo. Returns true iff suspicious.
function isSimsStatusContext(src, matchIndex) {
  const before = src.slice(Math.max(0, matchIndex - 400), matchIndex);
  const after  = src.slice(matchIndex, matchIndex + 200);
  // Strong positive signal: nearest enclosing supabasePatch/sbPatch call
  // points at the sims table.
  if (/(supabasePatch|sbPatch|supabaseInsert|sbPost|supabaseUpsert|sbUpsert)\s*\([^)]{0,200}['"`]sims[?']/.test(before)) return true;
  // SQL context: UPDATE sims ... SET ... status = 'x'
  if (/UPDATE\s+(public\.)?sims[\s\S]{0,300}$/i.test(before)) return true;
  // Otherwise: ignore
  return false;
}

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(js|ts|mjs|cjs|sql)$/i.test(entry)) out.push(full);
  }
  return out;
}

const files = walk(ROOT, []);
const violations = [];

for (const { column, constraint, allowed } of COLUMNS) {
  const rx = makeRx(column);
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    let m;
    rx.lastIndex = 0;
    while ((m = rx.exec(src))) {
      const value = m[1];
      if (allowed.has(value)) continue;
      // Generic-`status` literal only matters when writing to the sims table.
      if (column === 'status' && !isSimsStatusContext(src, m.index)) continue;
      const before = src.slice(0, m.index);
      const line = before.split('\n').length;
      violations.push({
        file: relative(process.cwd(), file),
        line,
        column,
        constraint,
        value,
        allowed: [...allowed].join(', '),
      });
    }
  }
}

if (violations.length === 0) {
  console.log('✓ DB constraint drift check: all guarded-column literals pass');
  for (const { column, allowed } of COLUMNS) {
    console.log(`  ${column.padEnd(18)} allowlist: ${[...allowed].join(', ')}`);
  }
  process.exit(0);
}

console.error('✗ DB constraint drift detected — literals NOT in the live CHECK constraint:');
console.error('');
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}`);
  console.error(`    column:    ${v.column}`);
  console.error(`    value:     '${v.value}'`);
  console.error(`    allowed:   ${v.allowed}`);
  console.error(`    fix:       update ${v.constraint} constraint via migration AND update COLUMNS in scripts/check_db_constraints.mjs`);
  console.error('');
}
console.error(`${violations.length} violation(s).`);
process.exit(1);
