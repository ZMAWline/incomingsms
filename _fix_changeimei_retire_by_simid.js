'use strict';
// Fix: retire old IMEI pool entry by sim_id (not gateway_id+port).
// Pool entries allocated via allocateImeiFromPool have gateway_id=null/port=null,
// so the slot-based retirement query matched nothing.
// Run: node _fix_changeimei_retire_by_simid.js

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src', 'mdn-rotator', 'index.js');
let src = fs.readFileSync(filePath, 'utf8');

// Normalize to LF
src = src.replace(/\r\n/g, '\n');

const OLD =
  '          // Retire old in_use IMEI for this slot first \u2014 must happen before allocating\n' +
  '          // a new one, otherwise the DB unique-per-sim_id constraint blocks the allocation.\n' +
  '          await supabasePatch(\n' +
  '            env,\n' +
  '            `imei_pool?gateway_id=eq.${encodeURIComponent(String(sim.gateway_id))}&port=eq.${encodeURIComponent(sim.port)}&status=eq.in_use`,\n' +
  '            { status: \'retired\', sim_id: null, assigned_at: null, updated_at: new Date().toISOString() }\n' +
  '          );';

const NEW =
  '          // Retire all in_use IMEI pool entries for this SIM (by sim_id).\n' +
  '          // Must happen before allocating a new one — the DB unique constraint\n' +
  '          // (one in_use per sim_id) would otherwise block the allocation.\n' +
  '          // Note: entries may have gateway_id=null, so slot-based filtering is unreliable.\n' +
  '          await supabasePatch(\n' +
  '            env,\n' +
  '            `imei_pool?sim_id=eq.${encodeURIComponent(String(sim_id))}&status=eq.in_use`,\n' +
  '            { status: \'retired\', sim_id: null, assigned_at: null, updated_at: new Date().toISOString() }\n' +
  '          );';

if (!src.includes(OLD)) {
  console.error('ERROR: target block not found');
  process.exit(1);
}

src = src.replace(OLD, NEW);
console.log('\u2713 Retirement query changed from gateway_id+port to sim_id');

// Write with CRLF
const out = src.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, out, 'utf8');
console.log('\u2713 Written src/mdn-rotator/index.js');
