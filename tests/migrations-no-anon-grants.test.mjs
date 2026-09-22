// No migration may grant anything to the public `anon` / `authenticated` roles
// or give them an RLS policy, unless the statement carries an explicit
// `-- anon-grant-approved: <reason>` comment.
//
// Why: the anon key is public by design. On 2026-09-22 an audit found PROD
// letting that key read 60+ tables and TEST letting it write sims and
// gateways. 20260922_lock_down_anon.sql revoked all of it. Nothing in this
// repo uses the anon key (every Worker uses service_role), so a new grant is
// almost always a copy-paste of Supabase's default boilerplate, not a need.
//
// Files listed in GRANDFATHERED predate the lockdown. They run before it on a
// rebuild, so the lockdown revokes what they grant. Reads source text only.

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname;
const DIRS = ['migrations', 'supabase/migrations'];

const GRANDFATHERED = new Set([
  'migrations/007_wing_bill_verification.sql',
  'migrations/test_environment_setup.sql',
  'supabase/migrations/20260428_rename_wing_bill_to_bill_audit.sql',
  'supabase/migrations/20260918_attempts_today.sql',
  'supabase/migrations/20260918_get_ledger_months.sql',
  'supabase/migrations/20260918_get_sms_counts_24h.sql',
  'supabase/migrations/20260918_increment_rotation_fail.sql',
  'supabase/migrations/20260918_list_zips_needing_refill.sql',
]);

const OPENS_ACCESS = /\b(grant\b[\s\S]*\bto\b|create\s+policy\b[\s\S]*\bto\b)[\s\S]*\b(anon|authenticated)\b/i;
const APPROVED = /--\s*anon-grant-approved:\s*\S/i;

function stripComments(sql) {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

function offendingStatements(sql) {
  return sql.split(';')
    .filter(chunk => OPENS_ACCESS.test(stripComments(chunk)) && !APPROVED.test(chunk))
    .map(chunk => stripComments(chunk).trim().replace(/\s+/g, ' ').slice(0, 160));
}

test('the anon lockdown migration exists', () => {
  assert.ok(existsSync(join(ROOT, 'supabase/migrations/20260922_lock_down_anon.sql')));
});

test('no migration grants to anon/authenticated without an approval comment', () => {
  const failures = [];
  for (const dir of DIRS) {
    for (const name of readdirSync(join(ROOT, dir))) {
      if (!name.endsWith('.sql')) continue;
      const rel = `${dir}/${name}`;
      if (GRANDFATHERED.has(rel)) continue;
      for (const stmt of offendingStatements(readFileSync(join(ROOT, rel), 'utf8'))) {
        failures.push(`${rel}: ${stmt}`);
      }
    }
  }
  assert.deepStrictEqual(failures, [],
    'Migration opens the public anon/authenticated roles. Remove the grant, or add '
    + '"-- anon-grant-approved: <reason>" to the statement with a narrow policy:\n'
    + failures.join('\n'));
});

test('the scanner catches a bare grant and honours the approval comment', () => {
  assert.strictEqual(offendingStatements('GRANT SELECT ON public.sims TO anon;').length, 1);
  assert.strictEqual(offendingStatements('CREATE POLICY p ON public.sims FOR SELECT TO authenticated USING (true);').length, 1);
  assert.strictEqual(offendingStatements('-- anon-grant-approved: storefront price list\nGRANT SELECT ON public.shop_prices TO anon;').length, 0);
  assert.strictEqual(offendingStatements('REVOKE ALL ON public.sims FROM anon;').length, 0);
  assert.strictEqual(offendingStatements('GRANT ALL ON public.sims TO service_role;').length, 0);
});
