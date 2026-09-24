#!/usr/bin/env node
/**
 * Read-only live verification of the 173 SUCCESS lines from
 * imei-audit/atomic-imei-update-ota-2026-08-28T21-54-14-287Z.csv.
 *
 * Uses the SAME read-only vendor readers the bad-rental-remediator uses
 * (src/bad-rental-remediator/vendor.mjs, src/shared/teltik-known-mdn.mjs)
 * so provider-vs-host semantics and the Teltik-known-MDN resolution order
 * match the rest of the codebase exactly. Does NOT call
 * recordHostingPortCheck/logPortStatusCarrierApi — no DB rows are written,
 * only the CSV/JSON artifact below.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import ws from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const dotenv = await import('dotenv');
dotenv.config({ path: resolve(__dirname, '../.dev.vars') });

const env = {
  ATOMIC_USERNAME: process.env.ATOMIC_USERNAME,
  ATOMIC_TOKEN: process.env.ATOMIC_TOKEN,
  ATOMIC_PIN: process.env.ATOMIC_PIN,
  ATOMIC_API_URL: process.env.ATOMIC_API_URL || 'https://solutionsatt-atomic.telgoo5.com:22712',
  TELTIK_API_KEY: process.env.TELTIK_API_KEY,
  RELAY_URL: process.env.RELAY_URL,
  RELAY_KEY: process.env.RELAY_KEY,
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
};

if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing Supabase credentials');
  process.exit(1);
}

const { atomicSubscriberInquiry, teltikLineView } = await import('../src/bad-rental-remediator/vendor.mjs');
const { resolveTeltikKnownMdn } = await import('../src/shared/teltik-known-mdn.mjs');

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { realtime: { transport: ws } });

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function readSuccessRows(csvPath) {
  const content = await readFile(csvPath, 'utf8');
  const lines = content.trim().split('\n');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    const [iccid, imei, mdn, simIdRaw, status] = parts;
    if (status === 'SUCCESS') rows.push({ iccid, imei, mdn, sim_id: Number(simIdRaw) });
  }
  return rows;
}

async function checkOne(row, sim) {
  const out = {
    sim_id: row.sim_id,
    iccid: row.iccid,
    imei_target: row.imei,
    db_imei: sim ? sim.imei : null,
    imei_match: sim ? sim.imei === row.imei : null,
    gateway_host: sim ? sim.gateway_host : null,
    mdn_used_carrier: null,
    provider_status: null,
    provider_evidence: null,
    mdn_used_host: null,
    mdn_source_host: null,
    host_status: null,
    host_evidence: null,
    online_verdict: null,
    error: null,
  };

  if (!sim) {
    out.provider_status = 'error';
    out.host_status = 'error';
    out.online_verdict = 'error';
    out.error = 'sim_not_found_in_db';
    return out;
  }

  // 1. Carrier/provider status — ATOMIC subsriberInquiry, queried by ICCID
  // alone (per src/bad-rental-remediator/vendor.mjs: passing MSISDN+sim
  // together makes Atomic reject with statusCode 908 whenever the DB MDN is
  // stale relative to the carrier).
  try {
    const carrier = await atomicSubscriberInquiry(env, { iccid: sim.iccid });
    if (carrier.ok && !carrier.not_found) {
      out.provider_status = carrier.attStatus === 'active' ? 'active' : (carrier.attStatus || 'unknown');
      out.mdn_used_carrier = carrier.MSISDN || null;
      out.provider_evidence = JSON.stringify({ attStatus: carrier.attStatus, MSISDN: carrier.MSISDN, BAN: carrier.BAN });
    } else if (carrier.not_found) {
      out.provider_status = 'not_found';
      out.provider_evidence = 'ATOMIC subsriberInquiry: subscriber not found';
    } else {
      out.provider_status = 'error';
      out.provider_evidence = carrier.error || 'unknown ATOMIC error';
    }
  } catch (e) {
    out.provider_status = 'error';
    out.provider_evidence = String((e && e.message) || e);
  }

  await sleep(180);

  // 2. Host/port status
  if (sim.gateway_host === 'teltik') {
    try {
      const picked = await resolveTeltikKnownMdn(env, { id: sim.id, iccid: sim.iccid, db_current_mdn: sim.msisdn });
      const mdnToUse = picked ? (picked.mdn10 || picked.mdn) : sim.msisdn;
      out.mdn_used_host = mdnToUse || null;
      out.mdn_source_host = picked ? picked.source : 'db_current_mdn_fallback';
      if (!mdnToUse) {
        out.host_status = 'error';
        out.host_evidence = 'no resolvable Teltik-known MDN';
      } else {
        const view = await teltikLineView(env, { mdn: mdnToUse });
        if (view.ok && !view.not_found) {
          out.host_status = view.port_status === 'online' ? 'online' : (view.port_status || 'unknown');
          out.host_evidence = JSON.stringify({ line_state: view.line_state, port_status: view.port_status, iccid_reported: view.iccid });
        } else if (view.not_found) {
          out.host_status = 'not_found';
          out.host_evidence = 'Teltik get-info: MDN not recognized (malformed lookup — not counted as offline)';
        } else {
          out.host_status = 'error';
          out.host_evidence = view.error || 'unknown Teltik error';
        }
      }
    } catch (e) {
      out.host_status = 'error';
      out.host_evidence = String((e && e.message) || e);
    }
    await sleep(280);
  } else if (sim.gateway_host === 'skyline') {
    out.host_status = 'not_tracked';
    out.host_evidence = sim.gateway_id
      ? 'gateway_host=skyline; no established read-only per-port SkyLine check was run for this batch'
      : 'gateway_host=skyline but sims.gateway_id/port are NULL — no port assignment on file, no host-status path available';
  } else {
    out.host_status = 'not_tracked';
    out.host_evidence = `unrecognized gateway_host=${sim.gateway_host}`;
  }

  // 3. Overall verdict
  const providerActive = out.provider_status === 'active';
  const hostOnline = out.host_status === 'online';
  const hostUnmonitored = out.host_status === 'not_tracked';
  const hostDown = !hostOnline && !hostUnmonitored && !['error', 'not_found'].includes(out.host_status);

  if (providerActive && hostOnline) out.online_verdict = 'online';
  else if (providerActive && hostUnmonitored) out.online_verdict = 'online_carrier_only_host_unmonitored';
  else if (!providerActive && out.provider_status !== 'error' && out.provider_status !== 'not_found') out.online_verdict = 'offline_carrier';
  else if (providerActive && hostDown) out.online_verdict = 'offline_host';
  else out.online_verdict = 'unknown';

  return out;
}

async function main() {
  const csvPath = resolve(__dirname, '../imei-audit/atomic-imei-update-ota-2026-08-28T21-54-14-287Z.csv');
  const rows = await readSuccessRows(csvPath);
  console.log(`Loaded ${rows.length} SUCCESS rows from batch CSV`);

  const simIds = rows.map((r) => r.sim_id);
  const { data: sims, error } = await supabase
    .from('sims')
    .select('id, iccid, imei, msisdn, vendor, status, gateway_id, port, gateway_host')
    .in('id', simIds);
  if (error) {
    console.error('Supabase read failed:', error);
    process.exit(1);
  }
  const simById = new Map(sims.map((s) => [s.id, s]));

  const results = new Array(rows.length);
  let idx = 0;
  const CONCURRENCY = 4;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (idx < rows.length) {
      const my = idx++;
      const row = rows[my];
      const sim = simById.get(row.sim_id);
      const r = await checkOne(row, sim);
      results[my] = r;
      console.log(`[${my + 1}/${rows.length}] sim ${row.sim_id} iccid ${row.iccid} provider=${r.provider_status} host=${r.host_status} verdict=${r.online_verdict}`);
    }
  });
  await Promise.all(workers);

  const counts = { online: 0, offline: 0, unknown_error: 0 };
  for (const r of results) {
    if (r.online_verdict === 'online' || r.online_verdict === 'online_carrier_only_host_unmonitored') counts.online++;
    else if (r.online_verdict === 'offline_carrier' || r.online_verdict === 'offline_host') counts.offline++;
    else counts.unknown_error++;
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const csvOutPath = resolve(__dirname, `../imei-audit/atomic-imei-live-verify-${ts}.csv`);
  const headers = [
    'sim_id', 'iccid', 'imei_target', 'db_imei', 'imei_match', 'gateway_host',
    'mdn_used_carrier', 'provider_status', 'provider_evidence',
    'mdn_used_host', 'mdn_source_host', 'host_status', 'host_evidence',
    'online_verdict', 'error',
  ];
  const csvLines = [headers.join(',')];
  for (const r of results) {
    csvLines.push(headers.map((h) => {
      const v = r[h];
      if (v == null) return '';
      const s = String(v).replace(/"/g, '""');
      return /[",\n]/.test(s) ? `"${s}"` : s;
    }).join(','));
  }
  await writeFile(csvOutPath, csvLines.join('\n'));

  const summaryPath = csvOutPath.replace('.csv', '-summary.json');
  const summary = {
    timestamp: new Date().toISOString(),
    source_batch_csv: 'atomic-imei-update-ota-2026-08-28T21-54-14-287Z.csv',
    total_success_rows_in_batch: rows.length,
    total_checked: results.length,
    online: counts.online,
    offline: counts.offline,
    unknown_or_error: counts.unknown_error,
    by_gateway_host: {
      teltik: results.filter((r) => r.gateway_host === 'teltik').length,
      skyline: results.filter((r) => r.gateway_host === 'skyline').length,
      other: results.filter((r) => r.gateway_host !== 'teltik' && r.gateway_host !== 'skyline').length,
    },
    by_verdict: results.reduce((acc, r) => { acc[r.online_verdict] = (acc[r.online_verdict] || 0) + 1; return acc; }, {}),
    methods: {
      provider_status: 'ATOMIC wholesale API subsriberInquiry (read-only), queried by ICCID alone, via src/bad-rental-remediator/vendor.mjs::atomicSubscriberInquiry',
      host_status_teltik: 'Teltik-known MDN resolved via src/shared/teltik-known-mdn.mjs::resolveTeltikKnownMdn, then GET /v1/get-info + GET /v1/port-status via src/bad-rental-remediator/vendor.mjs::teltikLineView',
      host_status_skyline: 'not run — no established read-only per-port SkyLine check path was exercised in this run',
    },
    notes: [
      'Read-only run: no IMEI/port/OTA/resend/DB mutations performed. No rows written to hosting_port_status_checks.',
      'A Teltik get-info "not found" (malformed/unrecognized MDN) is reported as host_status=not_found, NOT offline, per project convention.',
      'gateway_host=skyline lines (5 of 173) have no gateway_id/port on file in sims — host status is not_tracked for those; only carrier status was checked.',
    ],
  };
  await writeFile(summaryPath, JSON.stringify(summary, null, 2));

  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify(summary, null, 2));
  console.log(`\nArtifact CSV: ${csvOutPath}`);
  console.log(`Artifact summary: ${summaryPath}`);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
