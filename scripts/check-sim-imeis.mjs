#!/usr/bin/env node
/**
 * Check current IMEIs and plans for the SIMs
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

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { realtime: { transport: ws } });

async function main() {
  // Check first 5 SIMs from the pairs
  const iccids = [
    '89012804332291377301',
    '89012804332291377319',
    '89012804332291377327',
    '89012804332291377335',
    '89012804332291377343'
  ];
  
  for (const iccid of iccids) {
    const { data: sim } = await supabase
      .from('sims')
      .select('id, iccid, msisdn, vendor, status, imei, activation_zip, sim_numbers!inner(e164)')
      .eq('iccid', iccid)
      .limit(1)
      .single();
    
    if (sim) {
      console.log(`${iccid}:`);
      console.log(`  SIM ID: ${sim.id}`);
      console.log(`  Current IMEI: ${sim.imei || 'N/A'}`);
      console.log(`  Current IMEI TAC: ${sim.imei ? sim.imei.slice(0,8) : 'N/A'}`);
      console.log(`  Vendor: ${sim.vendor}`);
      console.log(`  Status: ${sim.status}`);
      console.log(`  MSISDN: ${sim.msisdn}`);
      console.log(`  ZIP: ${sim.activation_zip}`);
      console.log('');
    }
  }
  
  // Also check carrier_api_logs for any recent swapImei attempts
  const { data: logs } = await supabase
    .from('carrier_api_logs')
    .select('iccid, imei, step, error, response_body_json, created_at')
    .eq('vendor', 'atomic')
    .eq('step', 'swap_imei')
    .order('created_at', { ascending: false })
    .limit(10);
  
  console.log('Recent swapImei attempts:');
  for (const log of logs || []) {
    console.log(`  ${log.created_at} | ${log.iccid} | IMEI: ${log.imei} | Error: ${log.error}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });