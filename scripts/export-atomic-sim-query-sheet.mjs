#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/root/projects/incomingsms';
const ENV_PATH = process.env.ENV_PATH || path.join(ROOT, '.dev.vars');
const OUT_DIR = process.env.OUT_DIR || path.join(process.cwd(), 'artifacts');
const CHECKPOINT_PATH = path.join(OUT_DIR, 'atomic-query-export-checkpoint.jsonl');
const CSV_PATH = path.join(OUT_DIR, 'atomic-query-export.csv');
const SUMMARY_PATH = path.join(OUT_DIR, 'atomic-query-export-summary.json');
const TELTIK_BASE = 'https://api.smsgateway.xyz';

function loadEnv(file) {
  const env = { ...process.env };
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const k = trimmed.slice(0, idx).trim();
    let v = trimmed.slice(idx + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[k] = v;
  }
  return env;
}

const env = loadEnv(ENV_PATH);
for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'ATOMIC_USERNAME', 'ATOMIC_TOKEN', 'ATOMIC_PIN']) {
  if (!env[k]) throw new Error(`${k} missing`);
}
fs.mkdirSync(OUT_DIR, { recursive: true });

function relayUrl(url) {
  return env.RELAY_URL && env.RELAY_KEY ? `${env.RELAY_URL}/${url}` : url;
}
function relayHeaders(extra = {}) {
  return env.RELAY_URL && env.RELAY_KEY ? { ...extra, 'x-relay-key': env.RELAY_KEY } : extra;
}
function sbHeaders(extra = {}) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function toDigits10(v) {
  const d = String(v || '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) return d.slice(1);
  return d;
}
function toE164(v) {
  const d = String(v || '').replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return String(v || '');
}
async function fetchJson(url, init = {}, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  try {
    const resp = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await resp.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    return { ok: resp.ok, status: resp.status, text, json, headers: resp.headers };
  } finally {
    clearTimeout(timer);
  }
}
async function supabaseGetAll(pathQuery) {
  const out = [];
  const pageSize = 1000;
  for (let offset = 0; offset < 50000; offset += pageSize) {
    const url = `${env.SUPABASE_URL}/rest/v1/${pathQuery}`;
    const r = await fetchJson(url, { headers: sbHeaders({ Range: `${offset}-${offset + pageSize - 1}`, 'Range-Unit': 'items' }) }, 30000);
    if (!r.ok) throw new Error(`Supabase GET failed ${r.status}: ${r.text.slice(0, 500)}`);
    const rows = Array.isArray(r.json) ? r.json : [];
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
}
async function supabaseGet(pathQuery) {
  const url = `${env.SUPABASE_URL}/rest/v1/${pathQuery}`;
  const r = await fetchJson(url, { headers: sbHeaders() }, 30000);
  if (!r.ok) throw new Error(`Supabase GET failed ${r.status}: ${r.text.slice(0, 500)}`);
  return Array.isArray(r.json) ? r.json : [];
}
function flatten(prefix, value, out = {}) {
  if (value == null || typeof value !== 'object') {
    out[prefix] = value == null ? '' : value;
  } else if (Array.isArray(value)) {
    out[prefix] = JSON.stringify(value);
  } else {
    const keys = Object.keys(value);
    if (!keys.length) out[prefix] = '{}';
    for (const k of keys) flatten(prefix ? `${prefix}.${k}` : k, value[k], out);
  }
  return out;
}
async function atomicSubscriberInquiry(iccid) {
  const url = env.ATOMIC_API_URL || 'https://solutionsatt-atomic.telgoo5.com:22712';
  const body = {
    wholeSaleApi: {
      session: { userName: env.ATOMIC_USERNAME, token: env.ATOMIC_TOKEN, pin: env.ATOMIC_PIN },
      wholeSaleRequest: { requestType: 'subsriberInquiry', MSISDN: '', sim: iccid },
    },
  };
  const r = await fetchJson(relayUrl(url), {
    method: 'POST',
    headers: relayHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  }, 45000);
  let ws = r.json?.wholeSaleApi?.wholeSaleResponse || null;
  return { http_status: r.status, ok: r.ok && ws?.statusCode === '00', ws, raw: r.json, error: r.ok ? (ws?.statusCode === '00' ? null : `atomic_status_${ws?.statusCode || 'missing'}:${ws?.description || 'unknown'}`) : `atomic_http_${r.status}` };
}
function lineIccid(row) { return String(row?.iccid || row?.sim || row?.sim_number || '').replace(/\D/g, ''); }
function lineMdn(row) { return toDigits10(row?.mdn || row?.phone_number || row?.number || row?.phonenumber || row?.msisdn || ''); }
function normalizeHostPortState(httpStatus, body) {
  if (!httpStatus || httpStatus < 200 || httpStatus >= 300) return 'error';
  const state = String((body && (body.port_status || body.status || body.state)) || '').toLowerCase();
  if (['online', 'registered', 'active'].includes(state)) return 'online';
  if (['offline', 'down', 'inactive', 'not_registered', 'unregistered'].includes(state)) return 'offline';
  return 'unknown';
}
function payloadDestination(latest) {
  const raw = latest?.raw;
  if (raw && typeof raw === 'object') return raw.destination || raw.to || raw.mdn || raw.msisdn || null;
  return latest?.teltik_destination || null;
}
async function fetchLatestTeltikSms(simId) {
  const q = `inbound_sms?select=to_number,received_at,raw&sim_id=eq.${encodeURIComponent(String(simId))}&port=is.null&raw=not.is.null&order=received_at.desc&limit=1`;
  const rows = await supabaseGet(q).catch(() => []);
  return rows[0] || null;
}
async function getTeltikAllLines() {
  if (!env.TELTIK_API_KEY) return { rows: [], error: 'teltik_credentials_missing' };
  const url = `${TELTIK_BASE}/v1/all-lines/?apikey=${encodeURIComponent(env.TELTIK_API_KEY)}`;
  const r = await fetchJson(relayUrl(url), { method: 'GET', headers: relayHeaders() }, 45000);
  if (!r.ok || !Array.isArray(r.json)) return { rows: [], error: `teltik_all_lines_${r.status}` };
  return { rows: r.json, error: null };
}
async function resolveTeltikKnownMdn(sim, allLinesByIccid, allLinesMdns) {
  const latest = await fetchLatestTeltikSms(sim.id);
  const payloadRaw = payloadDestination(latest);
  const payload10 = toDigits10(payloadRaw);
  if (payload10.length === 10) return { mdn: payload10, source: 'teltik_inbound_sms_payload_mdn', received_at: latest.received_at || null };

  if (env.TELTIK_API_KEY && sim.iccid) {
    const url = `${TELTIK_BASE}/v1/get-phone-number/?apikey=${encodeURIComponent(env.TELTIK_API_KEY)}&iccid=${encodeURIComponent(sim.iccid)}`;
    const r = await fetchJson(relayUrl(url), { method: 'GET', headers: relayHeaders() }, 20000).catch(e => ({ ok: false, status: null, json: null, text: String(e) }));
    const mdn = r.ok ? toDigits10(r.json?.msisdn || r.json?.mdn || r.json?.phone_number || r.json?.phoneNumber || r.json?.number || '') : '';
    if (mdn.length === 10) return { mdn, source: 'teltik_get_phone_number_inventory', received_at: null };
  }

  const fromLine = allLinesByIccid.get(String(sim.iccid || '').replace(/\D/g, ''));
  const lineM = lineMdn(fromLine);
  if (lineM.length === 10) return { mdn: lineM, source: 'teltik_all_lines_inventory', received_at: null };

  const db10 = toDigits10(sim.current_db_mdn || sim.msisdn || '');
  if (db10.length === 10 && allLinesMdns.has(db10)) return { mdn: db10, source: 'teltik_all_lines_inventory', received_at: null };
  if (db10.length === 10) return { mdn: db10, source: 'db_current_mdn_unconfirmed', received_at: null };
  return { mdn: '', source: '', received_at: null };
}
async function teltikPortStatus(mdn) {
  const norm = toDigits10(mdn);
  if (!env.TELTIK_API_KEY) return { http_status: '', state: 'error', error: 'teltik_credentials_missing', raw: null };
  if (norm.length !== 10) return { http_status: '', state: 'error', error: 'no valid Teltik-known MDN — port-status skipped', raw: null };
  const url = `${TELTIK_BASE}/v1/port-status?apikey=${encodeURIComponent(env.TELTIK_API_KEY)}&mdn=${encodeURIComponent(norm)}`;
  const r = await fetchJson(relayUrl(url), { method: 'GET', headers: relayHeaders() }, 20000).catch(e => ({ ok: false, status: null, json: null, text: String(e) }));
  return { http_status: r.status || '', state: normalizeHostPortState(r.status, r.json), error: r.ok ? '' : `Teltik port-status HTTP ${r.status || 'exception'}`, raw: r.json || (r.text ? { raw: r.text.slice(0, 1000) } : null) };
}
function csvEscape(v) {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function writeCsv(rows) {
  const baseCols = [
    'sim_id','iccid','current_db_mdn','sims_msisdn','status','vendor_provider','carrier','gateway_host','reseller_ids','reseller_names','active_reseller_count',
    'atomic_ok','atomic_http_status','atomic_status_code','atomic_description','atomic_error',
    'teltik_host_applicable','teltik_port_state','teltik_port_http_status','teltik_port_mdn','teltik_port_mdn_source','teltik_port_mdn_received_at','teltik_port_checked_at','teltik_port_error','teltik_port_raw'
  ];
  const keys = new Set(baseCols);
  for (const row of rows) for (const k of Object.keys(row)) keys.add(k);
  const cols = [...baseCols, ...[...keys].filter(k => !baseCols.includes(k)).sort()];
  fs.writeFileSync(CSV_PATH, cols.map(csvEscape).join(',') + '\n' + rows.map(r => cols.map(c => csvEscape(r[c])).join(',')).join('\n') + '\n');
  return cols;
}
async function main() {
  console.log('Selecting Atomic SIMs from Supabase (read-only).');
  const select = 'id,iccid,msisdn,status,vendor,carrier,gateway_host,imei,att_ban,activation_zip,mobility_subscription_id,created_at,activated_at,last_rotation_at,last_mdn_rotated_at,reseller_sims(active,reseller_id,resellers(name)),sim_numbers(e164)';
  const sims = await supabaseGetAll(`sims?vendor=eq.atomic&select=${encodeURIComponent(select)}&sim_numbers.valid_to=is.null&order=id.asc`);
  const checkpointed = new Map();
  if (fs.existsSync(CHECKPOINT_PATH)) {
    for (const line of fs.readFileSync(CHECKPOINT_PATH, 'utf8').split(/\n/)) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      checkpointed.set(row.sim_id, row);
    }
  }
  console.log(`Selected ${sims.length} Atomic SIM rows. Existing checkpoint rows: ${checkpointed.size}.`);
  const hostedCount = sims.filter(s => String(s.gateway_host || '').toLowerCase() === 'teltik').length;
  console.log(`Teltik-hosted Atomic rows: ${hostedCount}.`);

  const allLines = hostedCount ? await getTeltikAllLines() : { rows: [], error: null };
  const allLinesByIccid = new Map();
  const allLinesMdns = new Set();
  for (const line of allLines.rows) {
    const ic = lineIccid(line); if (ic) allLinesByIccid.set(ic, line);
    const m = lineMdn(line); if (m) allLinesMdns.add(m);
  }
  if (allLines.error) console.log(`Teltik all-lines preload failed: ${allLines.error}`);

  let processed = checkpointed.size;
  for (const sim of sims) {
    if (checkpointed.has(sim.id)) continue;
    const activeNumbers = Array.isArray(sim.sim_numbers) ? sim.sim_numbers : [];
    const currentDbMdn = activeNumbers[0]?.e164 || (sim.msisdn ? toE164(sim.msisdn) : '');
    const resellerSims = Array.isArray(sim.reseller_sims) ? sim.reseller_sims.filter(r => r.active !== false) : [];
    const row = {
      sim_id: sim.id,
      iccid: sim.iccid || '',
      current_db_mdn: currentDbMdn || '',
      sims_msisdn: sim.msisdn || '',
      status: sim.status || '',
      vendor_provider: sim.vendor || '',
      carrier: sim.carrier || '',
      gateway_host: sim.gateway_host || '',
      reseller_ids: resellerSims.map(r => r.reseller_id).filter(Boolean).join(';'),
      reseller_names: resellerSims.map(r => r.resellers?.name).filter(Boolean).join(';'),
      active_reseller_count: resellerSims.length,
      teltik_host_applicable: String(sim.gateway_host || '').toLowerCase() === 'teltik' ? 'yes' : 'no',
    };

    try {
      const a = await atomicSubscriberInquiry(sim.iccid);
      row.atomic_ok = a.ok ? 'true' : 'false';
      row.atomic_http_status = a.http_status || '';
      row.atomic_status_code = a.ws?.statusCode || '';
      row.atomic_description = a.ws?.description || '';
      row.atomic_error = a.error || '';
      const flat = flatten('atomic_response', a.ws || a.raw || {});
      for (const [k, v] of Object.entries(flat)) row[k] = typeof v === 'object' ? JSON.stringify(v) : v;
    } catch (e) {
      row.atomic_ok = 'false';
      row.atomic_error = String(e && e.message || e).slice(0, 500);
    }

    if (row.teltik_host_applicable === 'yes') {
      const picked = await resolveTeltikKnownMdn({ ...sim, current_db_mdn: currentDbMdn }, allLinesByIccid, allLinesMdns);
      const checkedAt = new Date().toISOString();
      const p = await teltikPortStatus(picked.mdn);
      row.teltik_port_state = p.state || '';
      row.teltik_port_http_status = p.http_status || '';
      row.teltik_port_mdn = picked.mdn || '';
      row.teltik_port_mdn_source = picked.source || '';
      row.teltik_port_mdn_received_at = picked.received_at || '';
      row.teltik_port_checked_at = checkedAt;
      row.teltik_port_error = p.error || '';
      row.teltik_port_raw = p.raw ? JSON.stringify(p.raw) : '';
    }

    fs.appendFileSync(CHECKPOINT_PATH, JSON.stringify(row) + '\n');
    processed++;
    if (processed % 25 === 0 || processed === sims.length) console.log(`Processed ${processed}/${sims.length}`);
    await sleep(row.teltik_host_applicable === 'yes' ? 250 : 150);
  }

  const rows = [];
  for (const line of fs.readFileSync(CHECKPOINT_PATH, 'utf8').split(/\n/)) {
    if (line.trim()) rows.push(JSON.parse(line));
  }
  const unique = new Map(rows.map(r => [r.sim_id, r]));
  const finalRows = [...unique.values()].sort((a, b) => Number(a.sim_id) - Number(b.sim_id));
  const columns = writeCsv(finalRows);
  const summary = {
    generated_at: new Date().toISOString(),
    selected_atomic_sim_count: sims.length,
    csv_row_count: finalRows.length,
    csv_path: CSV_PATH,
    checkpoint_path: CHECKPOINT_PATH,
    columns_count: columns.length,
    columns,
    atomic_failures: finalRows.filter(r => r.atomic_ok !== 'true').length,
    teltik_host_applicable: finalRows.filter(r => r.teltik_host_applicable === 'yes').length,
    teltik_port_errors: finalRows.filter(r => r.teltik_host_applicable === 'yes' && r.teltik_port_state === 'error').length,
    teltik_port_online: finalRows.filter(r => r.teltik_port_state === 'online').length,
    teltik_port_offline: finalRows.filter(r => r.teltik_port_state === 'offline').length,
    teltik_port_unknown: finalRows.filter(r => r.teltik_port_state === 'unknown').length,
  };
  if (summary.csv_row_count !== summary.selected_atomic_sim_count) {
    summary.error = 'row count mismatch';
  }
  fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  if (summary.error) process.exitCode = 2;
}

main().catch(err => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
