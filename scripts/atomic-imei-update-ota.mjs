#!/usr/bin/env node
/**
 * Atomic IMEI Update + OTA Refresh from Teltik-completed pair list
 * Full run for all 344 pairs
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
  console.log('=== Atomic IMEI Update + OTA Refresh (Full Run) ===\n');
  
  const pairs = await readPairs();
  console.log(`Loaded ${pairs.length} ICCID+IMEI pairs from CSV\n`);
  
  const results = [];
  let successCount = 0;
  let failCount = 0;
  let skipCount = 0;
  
  const session = { userName: ATOMIC_USERNAME, token: ATOMIC_TOKEN, pin: ATOMIC_PIN };
  const atomicUrl = ATOMIC_API_URL;
  
  for (let i = 0; i < pairs.length; i++) {
    const { iccid, imei, mdn } = pairs[i];
    const progress = `[${i + 1}/${pairs.length}]`;
    console.log(`${progress} ICCID ${iccid} -> IMEI ${imei}`);
    
    const { data: sim, error: simError } = await supabase
      .from('sims')
      .select('id, iccid, msisdn, vendor, status, activation_zip, sim_numbers!inner(e164)')
      .eq('iccid', iccid)
      .limit(1)
      .single();
    
    if (simError || !sim) {
      console.log(`  SKIP: SIM not found in DB`);
      results.push({
        iccid, imei, mdn, sim_id: null,
        status: 'SKIP', reason: 'SIM not found in DB',
        swap_success: false, ota_success: false,
        swap_error: 'SIM not found', ota_error: '',
        timestamp: new Date().toISOString(),
      });
      skipCount++;
      continue;
    }
    
    if (sim.vendor !== 'atomic') {
      console.log(`  SKIP: Vendor is ${sim.vendor}`);
      results.push({
        iccid, imei, mdn, sim_id: sim.id,
        status: 'SKIP', reason: `Vendor is ${sim.vendor}`,
        swap_success: false, ota_success: false,
        swap_error: `Wrong vendor: ${sim.vendor}`, ota_error: '',
        timestamp: new Date().toISOString(),
      });
      skipCount++;
      continue;
    }
    
    if (sim.status === 'canceled') {
      console.log(`  SKIP: SIM is canceled`);
      results.push({
        iccid, imei, mdn, sim_id: sim.id,
        status: 'SKIP', reason: 'SIM is canceled',
        swap_success: false, ota_success: false,
        swap_error: 'Canceled', ota_error: '',
        timestamp: new Date().toISOString(),
      });
      skipCount++;
      continue;
    }
    
    const msisdn = resolveMsisdn(sim);
    if (!msisdn) {
      console.log(`  FAIL: No MSISDN on file`);
      results.push({
        iccid, imei, mdn, sim_id: sim.id,
        status: 'FAIL', reason: 'No MSISDN on file',
        swap_success: false, ota_success: false,
        swap_error: 'No MSISDN', ota_error: '',
        timestamp: new Date().toISOString(),
      });
      failCount++;
      continue;
    }
    
    const zipCode = resolveZip(null, sim);
    if (!zipCode) {
      console.log(`  FAIL: No ZIP on file`);
      results.push({
        iccid, imei, mdn, sim_id: sim.id,
        status: 'FAIL', reason: 'No ZIP on file',
        swap_success: false, ota_success: false,
        swap_error: 'No ZIP', ota_error: '',
        timestamp: new Date().toISOString(),
      });
      failCount++;
      continue;
    }
    
    const runId = `atomic_imei_${iccid}_${Date.now()}`;
    const requestBody = buildSwapImeiRequest({ session, msisdn, zipCode, imei });
    
    let swapSuccess = false;
    let swapError = '';
    let swapResponse = null;
    
    try {
      const res = await relayFetch(atomicUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
      
      swapSuccess = res.ok && isSwapSuccess(data);
      swapError = swapSuccess ? '' : swapErrorMessage(data, res.status);
      swapResponse = data;
      
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
        }
      } else {
        console.log(`  swapImei FAILED: ${swapError}`);
      }
    } catch (err) {
      swapSuccess = false;
      swapError = String(err);
      console.log(`  swapImei ERROR: ${swapError}`);
      await logCarrierApiCall({
        run_id: runId,
        step: 'swap_imei',
        iccid,
        imei,
        vendor: 'atomic',
        request_url: atomicUrl,
        request_method: 'POST',
        request_body: requestBody,
        response_status: 0,
        response_ok: false,
        response_body_text: '',
        response_body_json: null,
        error: swapError,
      });
    }
    
    let otaSuccess = false;
    let otaError = '';
    let otaResponse = null;
    
    if (swapSuccess) {
      console.log(`  Running OTA refresh...`);
      const otaRunId = `atomic_ota_${iccid}_${Date.now()}`;
      const otaBody = {
        wholeSaleApi: {
          session,
          wholeSaleRequest: { requestType: 'resendOtaProfile', MSISDN: msisdn, sim: iccid },
        },
      };
      
      try {
        const otaRes = await relayFetch(atomicUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(otaBody),
        });
        const otaText = await otaRes.text();
        let otaJson = {};
        try { otaJson = JSON.parse(otaText); } catch {}
        
        const otaR = otaJson?.wholeSaleApi?.wholeSaleResponse;
        otaSuccess = otaRes.ok && otaR?.statusCode === '00';
        otaError = otaSuccess ? '' : `ATOMIC OTA failed: ${otaR?.description || otaRes.status}`;
        otaResponse = otaJson;
        
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
      } catch (err) {
        otaSuccess = false;
        otaError = String(err);
        console.log(`  OTA refresh ERROR: ${otaError}`);
        await logCarrierApiCall({
          run_id: otaRunId,
          step: 'ota_refresh',
          iccid,
          imei: null,
          vendor: 'atomic',
          request_url: atomicUrl,
          request_method: 'POST',
          request_body: otaBody,
          response_status: 0,
          response_ok: false,
          response_body_text: '',
          response_body_json: null,
          error: otaError,
        });
      }
    } else {
      otaError = 'Skipped due to swapImei failure';
    }
    
    const overallStatus = swapSuccess && otaSuccess ? 'SUCCESS' : (swapSuccess ? 'PARTIAL' : 'FAIL');
    if (overallStatus === 'SUCCESS') successCount++;
    else failCount++;
    
    results.push({
      iccid, imei, mdn, sim_id: sim.id,
      status: overallStatus,
      reason: swapSuccess ? (otaSuccess ? '' : 'OTA failed') : 'swapImei failed',
      swap_success: swapSuccess,
      ota_success: otaSuccess,
      swap_error: swapError,
      ota_error: otaError,
      swap_response: JSON.stringify(swapResponse).slice(0, 500),
      ota_response: JSON.stringify(otaResponse).slice(0, 500),
      timestamp: new Date().toISOString(),
    });
    
    if (i < pairs.length - 1) {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const csvPath = resolve(__dirname, `../imei-audit/atomic-imei-update-ota-${timestamp}.csv`);
  
  const headers = [
    'iccid', 'imei', 'mdn', 'sim_id', 'status', 'reason',
    'swap_success', 'ota_success', 'swap_error', 'ota_error',
    'swap_response', 'ota_response', 'timestamp'
  ];
  
  const csvLines = [headers.join(',')];
  for (const r of results) {
    const safeSwapResponse = r.swap_response || '';
    const safeOtaResponse = r.ota_response || '';
    csvLines.push([
      r.iccid, r.imei, r.mdn, r.sim_id, r.status, r.reason,
      r.swap_success, r.ota_success,
      `"${r.swap_error.replace(/"/g, '""')}"`,
      `"${r.ota_error.replace(/"/g, '""')}"`,
      `"${safeSwapResponse.replace(/"/g, '""')}"`,
      `"${safeOtaResponse.replace(/"/g, '""')}"`,
      r.timestamp
    ].join(','));
  }
  
  await writeFile(csvPath, csvLines.join('\n'));
  
  console.log('\n=== SUMMARY ===');
  console.log(`Total pairs: ${pairs.length}`);
  console.log(`Success (swap + OTA): ${successCount}`);
  console.log(`Failed: ${failCount}`);
  console.log(`Skipped (non-Atomic/missing): ${skipCount}`);
  console.log(`Results saved to: ${csvPath}`);
  
  const summaryPath = csvPath.replace('.csv', '-summary.json');
  await writeFile(summaryPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    total_pairs: pairs.length,
    success_count: successCount,
    fail_count: failCount,
    skip_count: skipCount,
    results: results.map(r => ({
      iccid: r.iccid,
      imei: r.imei,
      sim_id: r.sim_id,
      status: r.status,
      reason: r.reason,
      swap_success: r.swap_success,
      ota_success: r.ota_success,
      swap_error: r.swap_error,
      ota_error: r.ota_error,
    })),
  }, null, 2));
  
  console.log(`Summary saved to: ${summaryPath}`);
  
  if (failCount > 0) {
    console.log('\n⚠️  Carrier API failures occurred. Blocking with summary.');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});