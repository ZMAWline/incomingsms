#!/usr/bin/env node
/**
 * Test Atomic IMEI Update + OTA Refresh with just first 5 pairs
 */

import { readFile } from 'node:fs/promises';
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

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing Supabase credentials');
  process.exit(1);
}
if (!ATOMIC_USERNAME || !ATOMIC_TOKEN || !ATOMIC_PIN) {
  console.error('Missing ATOMIC credentials');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  realtime: { transport: ws },
});

async function relayFetch(url, init = {}) {
  if (RELAY_URL && RELAY_KEY) {
    return fetch(`${RELAY_URL}/${url}`, {
      ...init,
      headers: { ...(init.headers || {}), 'x-relay-key': RELAY_KEY },
    });
  }
  return fetch(url, init);
}

function buildSwapImeiRequest({ session, msisdn, zipCode, imei }) {
  return {
    wholeSaleApi: {
      session,
      wholeSaleRequest: {
        requestType: 'swapImei',
        MSISDN: msisdn,
        zipCode,
        imei,
      },
    },
  };
}

function isSwapSuccess(json) {
  return !!(
    json &&
    json.wholeSaleApi &&
    json.wholeSaleApi.wholeSaleResponse &&
    json.wholeSaleApi.wholeSaleResponse.statusCode === '00'
  );
}

function swapErrorMessage(json, httpStatus) {
  const wr = json?.wholeSaleApi?.wholeSaleResponse;
  if (wr?.statusCode) return `ATOMIC statusCode ${wr.statusCode}: ${wr.description || ''}`;
  return `ATOMIC swapImei HTTP ${httpStatus}`;
}

function to10DigitMsisdn(raw) {
  if (!raw) return null;
  let d = String(raw).replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d.length === 10 ? d : null;
}

function resolveMsisdn(sim) {
  if (!sim) return null;
  const fromCol = to10DigitMsisdn(sim.msisdn);
  if (fromCol) return fromCol;
  const e164 = sim.sim_numbers?.[0]?.e164;
  return to10DigitMsisdn(e164);
}

function resolveZip(inputZip, sim) {
  const explicit = (inputZip == null ? '' : String(inputZip)).trim();
  if (explicit) return explicit;
  const z = sim && sim.activation_zip ? String(sim.activation_zip).trim() : '';
  return z || null;
}

async function logCarrierApiCall(log) {
  try {
    await supabase.from('carrier_api_logs').insert([{
      ...log,
      timestamp: new Date().toISOString(),
    }]);
  } catch (e) {
    console.warn('Failed to log carrier API call:', e.message);
  }
}

async function readPairs() {
  const csvPath = resolve(__dirname, '../imei-audit/shlomo-teltik-iccid-imei-pairs.csv');
  const content = await readFile(csvPath, 'utf8');
  const lines = content.trim().split('\n');
  const pairs = [];
  for (let i = 1; i < lines.length; i++) {
    const [iccid, imei, mdn] = lines[i].split(',');
    if (iccid && imei) {
      pairs.push({ iccid, imei, mdn });
    }
  }
  return pairs;
}

async function main() {
  console.log('=== Test Atomic IMEI Update (first 5) ===\n');
  
  const pairs = await readPairs();
  console.log(`Loaded ${pairs.length} pairs, testing first 5\n`);
  
  const session = { userName: ATOMIC_USERNAME, token: ATOMIC_TOKEN, pin: ATOMIC_PIN };
  const atomicUrl = ATOMIC_API_URL;
  
  for (let i = 0; i < Math.min(5, pairs.length); i++) {
    const { iccid, imei, mdn } = pairs[i];
    console.log(`[${i + 1}/5] Processing ICCID ${iccid} -> IMEI ${imei}`);
    
    const { data: sim, error: simError } = await supabase
      .from('sims')
      .select('id, iccid, msisdn, vendor, status, activation_zip, sim_numbers!inner(e164)')
      .eq('iccid', iccid)
      .limit(1)
      .single();
    
    if (simError || !sim) {
      console.log(`  SKIP: SIM not found in DB (${simError?.message})`);
      continue;
    }
    
    console.log(`  Found SIM #${sim.id}, vendor=${sim.vendor}, status=${sim.status}`);
    
    if (sim.vendor !== 'atomic') {
      console.log(`  SKIP: Vendor is ${sim.vendor}`);
      continue;
    }
    
    if (sim.status === 'canceled') {
      console.log(`  SKIP: SIM is canceled`);
      continue;
    }
    
    const msisdn = resolveMsisdn(sim);
    if (!msisdn) {
      console.log(`  FAIL: No MSISDN on file`);
      continue;
    }
    
    const zipCode = resolveZip(null, sim);
    if (!zipCode) {
      console.log(`  FAIL: No ZIP on file`);
      continue;
    }
    
    console.log(`  MSISDN: ${msisdn}, ZIP: ${zipCode}`);
    
    const runId = `test_atomic_imei_${iccid}_${Date.now()}`;
    const requestBody = buildSwapImeiRequest({ session, msisdn, zipCode, imei });
    
    console.log(`  Calling ATOMIC swapImei...`);
    
    try {
      const res = await relayFetch(atomicUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
      
      const swapSuccess = res.ok && isSwapSuccess(data);
      const swapError = swapSuccess ? '' : swapErrorMessage(data, res.status);
      
      await logCarrierApiCall({
        run_id: runId,
        step: 'swap_imei',
        iccid,
        imei,
        vendor: 'atomic',
        request_url: atomicUrl,
        request_method: 'POST',
        request_body: requestBody,
        response_status: res.status,
        response_ok: res.ok,
        response_body_text: text,
        response_body_json: data,
        error: swapError || null,
      });
      
      if (swapSuccess) {
        console.log(`  swapImei SUCCESS`);
        
        const { error: patchError } = await supabase
          .from('sims')
          .update({ imei })
          .eq('id', sim.id);
        
        if (patchError) {
          console.log(`  WARNING: DB update failed: ${patchError.message}`);
        } else {
          console.log(`  DB updated: sims.imei = ${imei}`);
        }
        
        // OTA Refresh
        console.log(`  Running OTA refresh...`);
        const otaRunId = `test_atomic_ota_${iccid}_${Date.now()}`;
        const otaBody = {
          wholeSaleApi: {
            session,
            wholeSaleRequest: { requestType: 'resendOtaProfile', MSISDN: msisdn, sim: iccid },
          },
        };
        
        const otaRes = await relayFetch(atomicUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(otaBody),
        });
        const otaText = await otaRes.text();
        let otaJson = {};
        try { otaJson = JSON.parse(otaText); } catch {}
        
        const otaR = otaJson?.wholeSaleApi?.wholeSaleResponse;
        const otaSuccess = otaRes.ok && otaR?.statusCode === '00';
        const otaError = otaSuccess ? '' : `ATOMIC OTA failed: ${otaR?.description || otaRes.status}`;
        
        await logCarrierApiCall({
          run_id: otaRunId,
          step: 'ota_refresh',
          iccid,
          imei: null,
          vendor: 'atomic',
          request_url: atomicUrl,
          request_method: 'POST',
          request_body: otaBody,
          response_status: otaRes.status,
          response_ok: otaRes.ok,
          response_body_text: otaText,
          response_body_json: otaJson,
          error: otaError || null,
        });
        
        if (otaSuccess) {
          console.log(`  OTA refresh SUCCESS`);
        } else {
          console.log(`  OTA refresh FAILED: ${otaError}`);
        }
      } else {
        console.log(`  swapImei FAILED: ${swapError}`);
      }
    } catch (err) {
      console.log(`  ERROR: ${err.message}`);
    }
    
    console.log('');
  }
  
  console.log('Test complete');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});