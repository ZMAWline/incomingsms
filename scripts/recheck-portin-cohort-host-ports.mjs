#!/usr/bin/env node
/**
 * Re-run the Teltik hosting port-status check over the 2026-08-24..09-04
 * port-in cohort.
 *
 * Why this exists: these SIMs were mislabeled `gateway_host='skyline'` by the
 * old `sims.gateway_host` DEFAULT (see
 * migrations/20260904_sims_gateway_host_default_teltik.sql). runHostingPortSweep
 * selects on `or=(gateway_host.eq.teltik,and(gateway_host.is.null,vendor.eq.teltik))`,
 * so while they were mislabeled they matched NEITHER arm and were skipped by the
 * 12h cron entirely — they have never been host-checked. Now that gateway_host
 * is correct, this re-runs the check for exactly that cohort.
 *
 * READ-ONLY against the carrier: runHostingPortSweep issues GET
 * /v1/port-status through the relay. It writes only audit history
 * (hosting_port_status_checks + a carrier_api_logs mirror) — no port reset,
 * no rotation, no carrier mutation. Same operation the 12h cron performs.
 *
 * Usage: node scripts/recheck-portin-cohort-host-ports.mjs
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { runHostingPortSweep } from '../src/shared/hosting-port-status.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dotenv = await import('dotenv');
dotenv.config({ path: resolve(__dirname, '../.dev.vars') });

const env = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  TELTIK_API_KEY: process.env.TELTIK_API_KEY,
  RELAY_URL: process.env.RELAY_URL,
  RELAY_KEY: process.env.RELAY_KEY,
};

for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'TELTIK_API_KEY']) {
  if (!env[k]) { console.error('missing ' + k + ' in .dev.vars'); process.exit(1); }
}
if (!env.RELAY_URL || !env.RELAY_KEY) {
  console.error('missing RELAY_URL/RELAY_KEY — carrier calls must go through the relay (constraints.md #11)');
  process.exit(1);
}

// The cohort: active, Teltik-hosted, no Skyline gateway seat, created in the
// port-in window — plus sim 770, the one legacy row reassigned to teltik by
// hand on 2026-09-04.
const COHORT_QUERY = 'sims?select=id'
  + '&status=eq.active&gateway_host=eq.teltik'
  + '&or=(and(gateway_id.is.null,port.is.null,created_at.gte.2026-08-24),id.eq.770)'
  + '&order=id.asc&limit=1000';

const resp = await fetch(env.SUPABASE_URL + '/rest/v1/' + COHORT_QUERY, {
  headers: {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
  },
});
if (!resp.ok) { console.error('cohort query failed HTTP ' + resp.status); process.exit(1); }
const simIds = (await resp.json()).map(r => r.id);
console.log('cohort size: ' + simIds.length);
if (!simIds.length) { console.log('nothing to check'); process.exit(0); }

const started = Date.now();
const summary = await runHostingPortSweep(env, {
  simIds,
  source: 'manual_sweep',
  concurrency: 5,
  maxSims: 1000, // never truncate an explicit id list
});

console.log('\n=== hosting port re-check ===');
console.log('elapsed_s      : ' + Math.round((Date.now() - started) / 1000));
console.log('ok             : ' + summary.ok);
console.log('total checked  : ' + summary.total);
console.log('truncated      : ' + summary.truncated);
console.log('online         : ' + (summary.online || 0));
console.log('offline        : ' + (summary.offline || 0));
console.log('unknown        : ' + (summary.unknown || 0));
console.log('error          : ' + (summary.error || 0));
console.log('wrong_mdn_retry: ' + (summary.wrong_mdn_retries || 0));

const byState = {};
for (const r of summary.results || []) (byState[r.state] ||= []).push(r);
for (const state of ['offline', 'unknown', 'error']) {
  const rows = byState[state] || [];
  if (!rows.length) continue;
  console.log('\n--- ' + state + ' (' + rows.length + ') ---');
  for (const r of rows.slice(0, 200)) {
    console.log('  sim=' + r.sim_id + ' iccid=' + r.iccid
      + (r.error ? ' err=' + String(r.error).slice(0, 120) : ''));
  }
}
