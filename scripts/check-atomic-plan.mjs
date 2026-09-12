#!/usr/bin/env node
/**
 * Check subscriber inquiry to understand plan/SOC for these SIMs
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
  // Check first 3 SIMs
  const iccids = [
    '89012804332291377301',
    '89012804332291377319',
    '89012804332291377327'
  ];
  
  for (const iccid of iccids) {
    const { data: sim } = await supabase
      .from('sims')
      .select('id, iccid, msisdn, vendor, status, imei, activation_zip, sim_numbers!inner(e164)')
      .eq('iccid', iccid)
      .limit(1)
      .single();
    
    if (!sim) continue;
    
    // Get MSISDN
    const msisdn = sim.msisdn || sim.sim_numbers?.[0]?.e164;
    if (!msisdn) continue;
    
    const cleanMsisdn = String(msisdn).replace(/\D/g, '').replace(/^1/, '');
    if (cleanMsisdn.length !== 10) continue;
    
    // Call ATOMIC subscriber inquiry
    const session = { userName: ATOMIC_USERNAME, token: ATOMIC_TOKEN, pin: ATOMIC_PIN };
    const body = {
      wholeSaleApi: {
        session,
        wholeSaleRequest: { requestType: 'subsriberInquiry', MSISDN: cleanMsisdn, sim: iccid },
      },
    };
    
    try {
      const res = await relayFetch(ATOMIC_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
      
      const result = data?.wholeSaleApi?.wholeSaleResponse;
      console.log(`\n${iccid} (MSISDN: ${cleanMsisdn}):`);
      console.log(`  statusCode: ${result?.statusCode}`);
      console.log(`  description: ${result?.description}`);
      console.log(`  attStatus: ${result?.Result?.attStatus}`);
      console.log(`  offeringCode: ${result?.Result?.offeringCode || result?.Result?.offering_code || result?.Result?.planCode || result?.Result?.plan_code || 'N/A'}`);
      console.log(`  pricePlan: ${result?.Result?.pricePlan || result?.Result?.price_plan || 'N/A'}`);
      console.log(`  sos: ${result?.Result?.sos || 'N/A'}`);
      if (result?.Result) {
        console.log(`  All Result fields:`, Object.keys(result.Result));
        for (const [k, v] of Object.entries(result.Result)) {
          if (typeof v === 'string' || typeof v === 'number') {
            console.log(`    ${k}: ${v}`);
          }
        }
      }
    } catch (e) {
      console.log(`\n${iccid}: ERROR - ${e.message}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });