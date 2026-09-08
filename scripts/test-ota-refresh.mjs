#!/usr/bin/env node
/**
 * Test OTA refresh after successful swapImei
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

async function main() {
  const session = { userName: ATOMIC_USERNAME, token: ATOMIC_TOKEN, pin: ATOMIC_PIN };
  
  const iccid = '89012804332291377301';
  const { data: sim } = await supabase.from('sims').select('id, iccid, msisdn, vendor, status, imei, activation_zip, sim_numbers!inner(e164)').eq('iccid', iccid).limit(1).single();
  
  if (!sim) { console.log('SIM not found'); return; }
  
  const msisdn = sim.msisdn || sim.sim_numbers?.[0]?.e164;
  const cleanMsisdn = String(msisdn).replace(/\D/g, '').replace(/^1/, '');
  console.log(`Current IMEI in DB: ${sim.imei}`);
  
  // OTA Refresh
  const otaBody = {
    wholeSaleApi: {
      session,
      wholeSaleRequest: { requestType: 'resendOtaProfile', MSISDN: cleanMsisdn, sim: iccid },
    },
  };
  
  const otaRes = await relayFetch(ATOMIC_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(otaBody),
  });
  const otaText = await otaRes.text();
  let otaJson; try { otaJson = JSON.parse(otaText); } catch {}
  const otaR = otaJson?.wholeSaleApi?.wholeSaleResponse;
  const otaOk = otaRes.ok && otaR?.statusCode === '00';
  const otaErr = otaOk ? '' : `ATOMIC OTA failed: ${otaR?.description || otaRes.status}`;
  
  console.log(`OTA Refresh: ${otaOk ? 'SUCCESS' : 'FAILED'} - ${otaErr}`);
  console.log(`Full response:`, JSON.stringify(otaJson, null, 2));
  
  // Check subscriber inquiry after OTA
  const inqBody = {
    wholeSaleApi: {
      session,
      wholeSaleRequest: { requestType: 'subsriberInquiry', MSISDN: cleanMsisdn, sim: iccid },
    },
  };
  
  const inqRes = await relayFetch(ATOMIC_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(inqBody),
  });
  const inqText = await inqRes.text();
  let inqJson; try { inqJson = JSON.parse(inqText); } catch {}
  const inqR = inqJson?.wholeSaleApi?.wholeSaleResponse;
  
  console.log(`\nPost-OTA inquiry:`);
  console.log(`  attStatus: ${inqR?.Result?.attStatus}`);
  console.log(`  BLIMEI: ${inqR?.Result?.BLIMEI}`);
  console.log(`  NWIMEI: ${inqR?.Result?.NWIMEI}`);
  console.log(`  BLDeviceTechnologyType: ${inqR?.Result?.BLDeviceTechnologyType}`);
}

main().catch(e => { console.error(e); process.exit(1); });