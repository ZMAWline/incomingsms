#!/usr/bin/env node
/**
 * Test if we can swap to the original IMEI TAC (35339576)
 */

import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import ws from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const dotenv = await import('dotenv');
dotenv.config({ path: resolve(__dirname, '../.dev.vars') });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ATOMIC_USERNAME = process.env.ATOMIC_USERNAME;
const ATOMIC_TOKEN = process.env.ATOMIC_TOKEN;
const ATOMIC_PIN = process.env.ATOMIC_PIN;
const ATOMIC_API_URL = process.env.ATOMIC_API_URL || 'https://solutionsatt-atomic.telgoo5.com:22712';
const RELAY_URL = process.env.RELAY_URL;
const RELAY_KEY = process.env.RELAY_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) process.exit(1);

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { realtime: { transport: ws } });

async function relayFetch(url, init = {}) {
  if (RELAY_URL && RELAY_KEY) {
    return fetch(`${RELAY_URL}/${url}`, { ...init, headers: { ...(init.headers || {}), 'x-relay-key': RELAY_KEY } });
  }
  return fetch(url, init);
}

function buildSwapImeiRequest({ session, msisdn, zipCode, imei }) {
  return { wholeSaleApi: { session, wholeSaleRequest: { requestType: 'swapImei', MSISDN: msisdn, zipCode, imei } } };
}

function isSwapSuccess(json) { return !!(json?.wholeSaleApi?.wholeSaleResponse?.statusCode === '00'); }
function swapErrorMessage(json, httpStatus) {
  const wr = json?.wholeSaleApi?.wholeSaleResponse;
  if (wr?.statusCode) return `ATOMIC statusCode ${wr.statusCode}: ${wr.description || ''}`;
  return `ATOMIC swapImei HTTP ${httpStatus}`;
}
function to10DigitMsisdn(raw) { if (!raw) return null; let d = String(raw).replace(/\D/g, ''); if (d.length === 11 && d.startsWith('1')) d = d.slice(1); return d.length === 10 ? d : null; }
function resolveMsisdn(sim) { if (!sim) return null; const fromCol = to10DigitMsisdn(sim.msisdn); if (fromCol) return fromCol; return to10DigitMsisdn(sim.sim_numbers?.[0]?.e164); }
function resolveZip(inputZip, sim) { const explicit = (inputZip == null ? '' : String(inputZip)).trim(); if (explicit) return explicit; return sim?.activation_zip ? String(sim.activation_zip).trim() : null; }

async function main() {
  const session = { userName: ATOMIC_USERNAME, token: ATOMIC_TOKEN, pin: ATOMIC_PIN };
  
  // Test with one SIM - try to swap to an IMEI with the same TAC as current (35339576)
  const iccid = '89012804332291377301';
  const testImei = '353395769999999'; // Same TAC 35339576
  
  const { data: sim } = await supabase.from('sims').select('id, iccid, msisdn, vendor, status, imei, activation_zip, sim_numbers!inner(e164)').eq('iccid', iccid).limit(1).single();
  
  if (!sim) { console.log('SIM not found'); return; }
  
  const msisdn = resolveMsisdn(sim);
  const zipCode = resolveZip(null, sim);
  console.log(`Testing ${iccid} with IMEI ${testImei} (TAC ${testImei.slice(0,8)})`);
  console.log(`MSISDN: ${msisdn}, ZIP: ${zipCode}`);
  
  const body = buildSwapImeiRequest({ session, msisdn, zipCode, imei: testImei });
  const res = await relayFetch(ATOMIC_API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  const ok = res.ok && isSwapSuccess(data);
  const err = ok ? '' : swapErrorMessage(data, res.status);
  
  console.log(`Result: ${ok ? 'SUCCESS' : 'FAILED'} - ${err}`);
  console.log(`Full response:`, JSON.stringify(data, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });