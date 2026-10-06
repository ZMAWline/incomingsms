// Runs the migration against an isolated temporary PostgreSQL 16 cluster.
// Requires local PostgreSQL binaries and root (to run the cluster as postgres).
// No credentials or production connections are used.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = mkdtempSync(join(tmpdir(), 'dashboard-admin-guard-'));
const bin = '/usr/lib/postgresql/16/bin/';
const port = '55439';
const run = (program, args) => execFileSync('runuser', ['-u', 'postgres', '--', bin + program, ...args], { encoding: 'utf8' });
execFileSync('chown', ['postgres:postgres', root]);
const args = ['-h', root, '-p', port, '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At'];
const sql = text => execFileSync(bin + 'psql', args, { input: text, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const a = '00000000-0000-0000-0000-000000000001';
const b = '00000000-0000-0000-0000-000000000002';
const c = '00000000-0000-0000-0000-000000000003';
function reset() {
  // TRUNCATE is used only inside this disposable cluster to reset fixtures.
  sql(`TRUNCATE public.dashboard_users CASCADE;
    INSERT INTO public.dashboard_users(id,username,username_folded,password_hash,role)
    VALUES ('${a}','a','a','fake','admin'),('${b}','b','b','fake','admin'),('${c}','c','c','fake','viewer');`);
}
function client() {
  const child = spawn(bin + 'psql', args);
  let stdout = '', stderr = '';
  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', d => { stderr += d; });
  const finished = new Promise(resolve => child.on('close', code => resolve({ code, stdout, stderr })));
  return {
    write: text => child.stdin.write(text + '\n'),
    end: text => child.stdin.end(text + '\n'), finished,
    async wait(marker) {
      const deadline = Date.now() + 5000;
      while (!stdout.includes(marker)) {
        if (Date.now() > deadline) throw Error('Timed out waiting for ' + marker + ': ' + stderr);
        await new Promise(r => setTimeout(r, 10));
      }
    },
  };
}
let started = false;
try {
  run('initdb', ['-D', join(root, 'data'), '-A', 'trust', '--no-locale']);
  run('pg_ctl', ['-D', join(root, 'data'), '-l', join(root, 'server.log'), '-o', `-k ${root} -p ${port} -h ''`, '-w', 'start']);
  started = true;
  sql('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;');
  sql(readFileSync(new URL('../migrations/20260908_dashboard_users_auth.sql', import.meta.url), 'utf8'));
  const migration = readFileSync(new URL('../supabase/migrations/20261006_preserve_last_dashboard_admin.sql', import.meta.url), 'utf8');
  sql(migration);
  sql(migration); // Reapplication must preserve the guard row and triggers.
  sql('GRANT USAGE ON SCHEMA public TO service_role; GRANT ALL ON public.dashboard_users TO service_role;');

  for (const isolation of ['READ COMMITTED', 'REPEATABLE READ']) {
    for (const action of ['demote', 'disable', 'delete']) {
      reset();
      const losing = id => action === 'delete' ? `DELETE FROM public.dashboard_users WHERE id='${id}';`
        : `UPDATE public.dashboard_users SET ${action === 'demote' ? "role='viewer'" : "status='disabled'"} WHERE id='${id}';`;
      const second = client();
      second.write(`SET ROLE service_role; BEGIN ISOLATION LEVEL ${isolation}; SELECT count(*) FROM public.dashboard_users; SELECT 'second_snapshot';`);
      await second.wait('second_snapshot');
      const first = client();
      first.write(`SET ROLE service_role; BEGIN; ${losing(a)} SELECT 'first_changed';`);
      await first.wait('first_changed');
      second.end(`${losing(b)} COMMIT;`);
      first.end('COMMIT;');
      const [one, two] = await Promise.all([first.finished, second.finished]);
      assert.equal(one.code, 0, one.stderr);
      assert.notEqual(two.code, 0, 'concurrent final admin removal must fail');
      assert.match(two.stderr, isolation === 'READ COMMITTED' ? /last_active_dashboard_admin/ : /could not serialize/);
      assert.equal(sql("SELECT count(*) FROM public.dashboard_users WHERE role='admin' AND status='active';"), '1');
      console.log(`PASS concurrent ${action}, ${isolation}`);
    }
  }
  reset();
  assert.throws(() => sql("UPDATE public.dashboard_users SET role='viewer' WHERE role='admin';"), /last_active_dashboard_admin/);
  assert.equal(sql("SELECT count(*) FROM public.dashboard_users WHERE role='admin';"), '2');
  assert.throws(() => sql('DELETE FROM public.dashboard_users;'), /last_active_dashboard_admin/);
  sql(`UPDATE public.dashboard_users SET role=CASE WHEN id='${c}' THEN 'admin' ELSE 'viewer' END;`);
  assert.equal(sql("SELECT count(*) FROM public.dashboard_users WHERE role='admin';"), '1');
  assert.throws(() => sql(`UPDATE public.dashboard_users SET id='00000000-0000-0000-0000-000000000004',role='viewer' WHERE id='${c}';`), /last_active_dashboard_admin/);
  sql(`UPDATE public.dashboard_users SET last_login_at=now() WHERE id='${c}';`);
  assert.equal(sql("SELECT has_table_privilege('anon','public.dashboard_admin_guard','UPDATE');"), 'f');
  assert.equal(sql("SELECT has_table_privilege('service_role','public.dashboard_admin_guard','UPDATE');"), 'f');
  assert.equal(sql("SELECT has_function_privilege('authenticated','public.preserve_last_dashboard_admin()','EXECUTE');"), 'f');
  console.log('PASS bulk rollback, atomic admin handover, login updates, restricted privileges, idempotent migration');
} finally {
  if (started) run('pg_ctl', ['-D', join(root, 'data'), '-m', 'immediate', '-w', 'stop']);
  rmSync(root, { recursive: true, force: true });
}
