// INC-27 regression: the 50-per-tick limit must count only REAL actionable
// runs (vendor/action/escalation attempts). Non-actionable rows —
// skipped_cooldown gate bookkeeping, duplicate/expired/stale DB-only
// dismissals, lost claim races — are scanned past instead of consuming the
// budget. Proves:
//   - 50 stale prior-day reports at the head of the queue do NOT block a
//     same-day actionable report behind them: the tick dismisses all 50 and
//     still processes the actionable report in the same run,
//   - dismissals/skips are counted in processed/outcomes but not attempted,
//   - expired dismissals never touch a vendor surface (all traffic is DB),
//   - the batch loop is bounded by SCAN_CAP even when rows never leave the
//     intake window (claim CAS permanently failing) — no infinite loop.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.join(__dirname, '..', 'src', 'bad-rental-remediator', 'index.js');
const TMP_INDEX_PATH = path.join(__dirname, '..', 'src', 'bad-rental-remediator', '.tmp-real-run-index.mjs');
const SRC = fs.readFileSync(INDEX_PATH, 'utf8');

async function importWorker() {
  // package.json is intentionally CommonJS, but the Worker entrypoint is ESM
  // for Wrangler. Copy it beside its relative .mjs imports so node:test can
  // import it without changing production file names.
  fs.writeFileSync(TMP_INDEX_PATH, SRC);
  try {
    return (await import(`${TMP_INDEX_PATH}?t=${Date.now()}`)).default;
  } finally {
    try { fs.unlinkSync(TMP_INDEX_PATH); } catch (_) { /* best effort */ }
  }
}

// ---------------------------------------------------------
// Fake Supabase + KV harness. Stateful rental_reports so that a processed row
// actually leaves the intake window (status flip / last_auto_attempt_at stamp)
// and re-fetch batches behave like PostgREST would.
// ---------------------------------------------------------

const DEFER_MS = 15 * 60 * 1000;

function makeHarness({ reports, sims = {}, rentals = {}, claimAlwaysFails = false }) {
  const db = {
    reports: new Map(reports.map(r => [String(r.id), { ...r }])),
    attempts: [],
    events: [],
    urls: [],
  };
  const kvStore = { bad_rental_remediator_enabled: 'true' };

  const idFrom = (u) => {
    const m = u.match(/[?&]id=eq\.([^&]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  };

  const fakeFetch = async (url, init) => {
    const u = String(url);
    const method = (init && init.method) || 'GET';
    db.urls.push({ url: u, method });

    // Expired-open sweep fetch: scans all open auto-remediation buckets except
    // operator_locked so prior-day escalations/verify-pending rows can close too.
    if (u.includes('/rental_reports?status=in.') && u.includes('auto_remediation_state.in.(queued') && method === 'GET') {
      const limit = parseInt((u.match(/[?&]limit=(\d+)/) || [])[1] || '1000', 10);
      const rows = [...db.reports.values()].filter(r =>
        (r.status === 'received' || r.status === 'in_triage')
        && (r.auto_remediation_state == null || ['queued', 'in_progress', 'verify_pending', 'escalated'].includes(r.auto_remediation_state)));
      rows.sort((a, b) => a.received_at < b.received_at ? -1 : a.received_at > b.received_at ? 1 : 0);
      return new Response(JSON.stringify(rows.slice(0, limit)), { status: 200 });
    }
    // Intake fetch.
    if (u.includes('/rental_reports?status=in.') && method === 'GET') {
      const limit = parseInt((u.match(/[?&]limit=(\d+)/) || [])[1] || '50', 10);
      const cutoff = Date.now() - DEFER_MS;
      const rows = [...db.reports.values()].filter(r =>
        (r.status === 'received' || r.status === 'in_triage')
        && (r.auto_remediation_state == null || r.auto_remediation_state === 'queued')
        && (!r.last_auto_attempt_at || Date.parse(r.last_auto_attempt_at) < cutoff));
      rows.sort((a, b) => {
        const an = a.last_auto_attempt_at ? 1 : 0, bn = b.last_auto_attempt_at ? 1 : 0;
        if (an !== bn) return an - bn;
        if (an && a.last_auto_attempt_at !== b.last_auto_attempt_at) {
          return a.last_auto_attempt_at < b.last_auto_attempt_at ? -1 : 1;
        }
        return a.received_at < b.received_at ? -1 : a.received_at > b.received_at ? 1 : 0;
      });
      return new Response(JSON.stringify(rows.slice(0, limit)), { status: 200 });
    }
    // Newer-open-report probe.
    if (u.includes('/rental_reports?sim_id=eq.') && method === 'GET') {
      return new Response('[]', { status: 200 });
    }
    // Stale-claim recovery sweep.
    if (u.includes('/rental_reports?auto_remediation_state=eq.in_progress') && method === 'PATCH') {
      return new Response('[]', { status: 200 });
    }
    if (u.includes('/rental_reports?id=eq.')) {
      const row = db.reports.get(idFrom(u));
      if (method === 'PATCH') {
        const body = JSON.parse(init.body);
        // Claim CAS — filter carries the or=(auto_remediation_state...) guard.
        if (u.includes('&or=(auto_remediation_state')) {
          const claimable = !claimAlwaysFails && row
            && (row.auto_remediation_state == null || row.auto_remediation_state === 'queued');
          if (claimable) Object.assign(row, body);
          return new Response(null, {
            status: 204,
            headers: { 'Content-Range': claimable ? '0-0/1' : '*/0' },
          });
        }
        if (row) Object.assign(row, body);
        return new Response('[]', { status: 200 });
      }
      return new Response(JSON.stringify(row ? [row] : []), { status: 200 });
    }
    if (u.includes('/rental_report_remediation_attempts')) {
      if (method === 'POST') {
        db.attempts.push(JSON.parse(init.body));
        return new Response('[]', { status: 201 });
      }
      const m = u.match(/report_id=eq\.([^&]+)/);
      const rid = m ? decodeURIComponent(m[1]) : null;
      return new Response(JSON.stringify(
        db.attempts.filter(a => String(a.report_id) === String(rid))), { status: 200 });
    }
    if (u.includes('/rental_report_events') && method === 'POST') {
      db.events.push(JSON.parse(init.body));
      return new Response('[]', { status: 201 });
    }
    if (u.includes('/sims?id=eq.')) {
      const s = sims[idFrom(u)];
      return new Response(JSON.stringify(s ? [s] : []), { status: 200 });
    }
    if (u.includes('/rentals?id=eq.')) {
      const r = rentals[idFrom(u)];
      return new Response(JSON.stringify(r ? [r] : []), { status: 200 });
    }
    return new Response('[]', { status: 200 });
  };

  const env = {
    SUPABASE_URL: 'https://sb.test',
    SUPABASE_SERVICE_ROLE_KEY: 'srv',
    ADMIN_RUN_SECRET: 's',
    REMEDIATOR_KV: {
      async get(k) { return kvStore[k] === undefined ? null : kvStore[k]; },
      async put(k, v) { kvStore[k] = v; },
      async delete(k) { delete kvStore[k]; },
    },
    SKYLINE_GATEWAY: {
      async fetch() { return new Response(JSON.stringify({ status: 'offline' }), { status: 200 }); },
    },
  };

  const orig = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  return { env, db, restore: () => { globalThis.fetch = orig; } };
}

async function runTickViaWorker(env) {
  const worker = await importWorker();
  const resp = await worker.fetch(new Request('https://w/run?secret=s'), env);
  const body = await resp.json();
  assert.equal(body.ok, true);
  return body.result;
}

const staleReceivedAt = () => new Date(Date.now() - 48 * 3600 * 1000).toISOString();

// ---------------------------------------------------------
// 50 stale prior-day duplicates must not block a same-day actionable report.
// ---------------------------------------------------------

test('runTick scans past 50 stale dismissals and still reaches the actionable report', async () => {
  const reports = [];
  for (let i = 1; i <= 50; i++) {
    reports.push({
      id: i, status: 'received', received_at: staleReceivedAt(),
      sim_id: null, sim_number_id: null, rental_id: null, reseller_id: null,
      e164: null, auto_remediation_state: null, last_auto_attempt_at: null,
    });
  }
  // Same-day actionable report BEHIND the 50 stale ones (received_at newest).
  // Sim has a gateway+port and SkyLine reports offline → S5 classify_only,
  // a real (attempt-inserting, non-dismissal) run.
  reports.push({
    id: 51, status: 'received', received_at: new Date().toISOString(),
    sim_id: 'sim-51', sim_number_id: null, rental_id: 'r-51', reseller_id: 'rs-1',
    e164: '+15550001111', auto_remediation_state: null, last_auto_attempt_at: null,
  });
  const { env, db, restore } = makeHarness({
    reports,
    sims: { 'sim-51': { id: 'sim-51', iccid: '890', vendor: null, gateway_host: null, status: 'active', msisdn: '5550001111', gateway_id: 'gw-1', port: '1' } },
    rentals: { 'r-51': { id: 'r-51', sim_id: 'sim-51', reseller_id: 'rs-1', reseller_rental_id: 'rr-51', rental_date: '2026-07-29', minted_at: new Date().toISOString() } },
  });
  try {
    const result = await runTickViaWorker(env);

    // All 51 rows processed in ONE tick — the 50 dismissals did not exhaust
    // the intake window.
    assert.equal(result.processed, 51);
    assert.equal(result.expired_open_dismissed, 50);
    assert.equal(result.expired_open_scanned, 51);
    assert.equal(result.scanned, 1);
    assert.equal(result.outcomes.duplicate, 50, 'all stale reports dismissed as duplicate');
    assert.equal(result.outcomes.no_change, 1, 'actionable report classified (S5)');

    // Only the actionable report consumed the real-run budget.
    assert.equal(result.attempted, 1, 'dismissals must not consume the 50 real-run budget');

    // The actionable report really ran: attempt row recorded.
    const a51 = db.attempts.filter(a => String(a.report_id) === '51');
    assert.equal(a51.length, 1);
    assert.equal(a51[0].outcome, 'no_change');

    // Every stale report was closed as duplicate; attempts recorded for each.
    for (let i = 1; i <= 50; i++) {
      assert.equal(db.reports.get(String(i)).status, 'duplicate');
    }
    assert.equal(db.attempts.length, 51);

    // Safety: expired dismissals fired no vendor call — every global-fetch URL
    // is the fake Supabase host (SkyLine probe rides its own binding).
    for (const c of db.urls) {
      assert.ok(c.url.startsWith('https://sb.test/'), 'unexpected non-DB call: ' + c.url);
    }
  } finally { restore(); }
});

test('expired sweep dismisses prior-day escalated and verify-pending rows too', async () => {
  const reports = [
    { id: 901, status: 'in_triage', received_at: staleReceivedAt(), sim_id: null, sim_number_id: null, rental_id: null, reseller_id: null, e164: null, auto_remediation_state: 'escalated', last_auto_attempt_at: null },
    { id: 902, status: 'received', received_at: staleReceivedAt(), sim_id: null, sim_number_id: null, rental_id: null, reseller_id: null, e164: null, auto_remediation_state: 'verify_pending', last_auto_attempt_at: null },
    { id: 903, status: 'received', received_at: new Date().toISOString(), sim_id: null, sim_number_id: null, rental_id: null, reseller_id: null, e164: null, auto_remediation_state: 'escalated', last_auto_attempt_at: null },
  ];
  const { env, db, restore } = makeHarness({ reports });
  try {
    const result = await runTickViaWorker(env);
    assert.equal(result.expired_open_dismissed, 2);
    assert.equal(result.outcomes.duplicate, 2);
    assert.equal(result.attempted, 0);
    assert.equal(db.reports.get('901').status, 'duplicate');
    assert.equal(db.reports.get('902').status, 'duplicate');
    assert.equal(db.reports.get('903').status, 'received');
  } finally { restore(); }
});

// ---------------------------------------------------------
// No infinite loop: rows that never leave the intake window (claim CAS always
// loses) are bounded by SCAN_CAP, and skips never count as real runs.
// ---------------------------------------------------------

test('runTick terminates via SCAN_CAP when rows never leave the intake window', async () => {
  const reports = [];
  for (let i = 1; i <= 50; i++) {
    reports.push({
      id: i, status: 'received', received_at: new Date().toISOString(),
      sim_id: null, sim_number_id: null, rental_id: null, reseller_id: null,
      e164: null, auto_remediation_state: null, last_auto_attempt_at: null,
    });
  }
  const { env, restore } = makeHarness({ reports, claimAlwaysFails: true });
  try {
    const result = await runTickViaWorker(env);
    assert.equal(result.scanned, 400, 'loop must stop exactly at SCAN_CAP');
    assert.equal(result.processed, 400);
    assert.equal(result.attempted, 0, 'lost claim races are not real runs');
    assert.equal(result.outcomes.skipped_not_claimed, 400);
  } finally { restore(); }
});

// ---------------------------------------------------------
// Source assertions (same style as the INC-26 starvation tests).
// ---------------------------------------------------------

test('real-run budget excludes exactly the non-actionable outcomes', () => {
  assert.ok(/NON_ACTIONABLE_OUTCOMES\s*=\s*new Set\(\[\s*'skipped_not_claimed',\s*'skipped_cooldown',\s*'duplicate'\s*\]\)/.test(SRC),
    'non-actionable set must cover claim races, cooldown skips and dismissals');
  assert.ok(SRC.includes('if (res.attemptInserted && !NON_ACTIONABLE_OUTCOMES.has(res.outcome)) attempted++;'),
    'attempted must only count real actionable runs');
});

test('intake loop is bounded by both the real-run limit and the scan cap', () => {
  assert.ok(SRC.includes('while (attempted < INTAKE_LIMIT && reportsFetched < SCAN_CAP)'),
    'loop must stop at 50 real runs or the scan cap');
  assert.ok(/const SCAN_CAP = \d+/.test(SRC), 'scan cap must be a fixed constant');
  assert.ok(SRC.includes('if (reports.length < batchSize) break;'),
    'a short batch (queue drained) must end the loop');
});
