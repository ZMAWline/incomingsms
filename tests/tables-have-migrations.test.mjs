// Every table or view a worker reads or writes must be created in a migration file.
//
// Why: on 2026-09-23 thirteen tables the workers use every day existed only in
// the live PROD database — remediation_attempts, billing_ledger, sim_sms_daily,
// imei_pool, plan_rates, cron_runs and seven more. No file in this repo created
// them, so TEST was missing most of them and a rebuild would have lost them.
// They were captured into supabase/migrations/20260923_*.sql.
//
// This test scans src/ for PostgREST table references and migrations/ +
// supabase/migrations/ for CREATE TABLE / CREATE VIEW, and fails if a name is
// used but never created. It reads source text only — no database connection.

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

// Reference shapes in this codebase:
//   `${env.SUPABASE_URL}/rest/v1/sims?select=...`      raw fetch
//   sbGet(env, `sims?select=...`) and the other helpers  shared/supabase-rest.mjs, supabase.ts
//   supabaseGet(env, 'sims?...')                        per-worker helpers
//   'sims?select=...' / `sims?id=eq.${id}`              dashboard path strings
const NAME = '([a-z][a-z0-9_]*)';
const REF_PATTERNS = [
  new RegExp(`/rest/v1/${NAME}`, 'g'),
  new RegExp(`\\b(?:sbGet|sbGetAll|sbPost|sbPatch|sbDelete|supabaseGet|supabaseSelect|supabaseInsert|supabasePatch)\\(\\s*[A-Za-z0-9_.]+\\s*,\\s*['"\`]${NAME}`, 'g'),
  new RegExp(`['"\`/]${NAME}\\?(?:select=|on_conflict=|[a-z_]+=(?:eq|neq|in|is|gt|gte|lt|lte|like|ilike|not)\\.)`, 'g'),
];
// Path segments that match the shapes above but are not tables.
const NOT_TABLES = new Set(['rpc']);

function referencedTables() {
  const found = new Map(); // name -> first "file:line"
  for (const file of walk(join(ROOT, 'src'), ['.js', '.mjs', '.ts', '.html'])) {
    const text = readFileSync(file, 'utf8');
    for (const rx of REF_PATTERNS) {
      rx.lastIndex = 0;
      let m;
      while ((m = rx.exec(text)) !== null) {
        if (NOT_TABLES.has(m[1]) || found.has(m[1])) continue;
        const line = text.slice(0, m.index).split('\n').length;
        found.set(m[1], `${file.slice(ROOT.length)}:${line}`);
      }
    }
  }
  return found;
}

function createdRelations() {
  const created = new Set();
  const dirs = [join(ROOT, 'migrations'), join(ROOT, 'supabase', 'migrations')];
  // `create [or replace] [materialized] table|view [if not exists] [public.]name`
  const rx = /create\s+(?:or\s+replace\s+)?(?:materialized\s+)?(?:table|view)\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z][a-z0-9_]*)"?/gi;
  for (const dir of dirs) {
    for (const file of walk(dir, ['.sql'])) {
      const text = readFileSync(file, 'utf8');
      rx.lastIndex = 0;
      let m;
      while ((m = rx.exec(text)) !== null) created.add(m[1].toLowerCase());
    }
  }
  return created;
}

test('every table the workers reference is created in a migration file', () => {
  const referenced = referencedTables();
  const created = createdRelations();

  assert.ok(referenced.size > 20, `found only ${referenced.size} table references — the scanner regexes are broken`);

  const missing = [...referenced.entries()]
    .filter(([name]) => !created.has(name))
    .map(([name, where]) => `  ${name}  (referenced at ${where})`);

  assert.deepEqual(missing, [],
    'These tables are used but created nowhere in migrations/ or supabase/migrations/.\n' +
    'Capture the live definition from PROD (columns, constraints, indexes, RLS, grants) into a\n' +
    'CREATE TABLE IF NOT EXISTS migration:\n' +
    missing.join('\n'));
});

test('the thirteen tables captured from PROD on 2026-09-23 stay in the repo', () => {
  const created = createdRelations();
  for (const name of [
    'bill_audit_lines',
    'bill_audit_uploads',
    'billing_ledger',
    'cron_runs',
    'gateway_defective_slots',
    'imei_pool',
    'pending_review_items',
    'plan_rates',
    'remediation_attempts',
    'reseller_actions_log',
    'rotation_audit',
    'sim_sms_daily',
    'teltik_lifecycle_events',
  ]) {
    assert.ok(created.has(name), `${name} lost its migration file`);
  }
});
