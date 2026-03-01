'use strict';
// Fix: retire old IMEI pool entry BEFORE allocateImeiFromPool in change_imei handler.
// Bug: retirement happened after allocation → DB constraint imei_pool_unique_in_use_sim
//      blocked allocation because SIM already had an in_use entry.
// Run: node _fix_changeimei_retire_order.js

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src', 'mdn-rotator', 'index.js');
let src = fs.readFileSync(filePath, 'utf8');

// Normalize to LF
src = src.replace(/\r\n/g, '\n');

// PART 1: Add retirement before the try block
const OLD1 =
  '          try {\n' +
  '            if (autoImei) {\n' +
  '              // Allocate from pool \u2014 temporarily attach to sim_id\n' +
  '              allocatedEntry = await allocateImeiFromPool(env, sim_id);\n' +
  '              targetImei = allocatedEntry.imei;\n' +
  '              console.log(`[ChangeImei] SIM ${iccid}: auto-allocated IMEI ${targetImei}`);\n' +
  '            }\n' +
  '\n' +
  '            // Check eligibility';

const NEW1 =
  '          // Retire old in_use IMEI for this slot first \u2014 must happen before allocating\n' +
  '          // a new one, otherwise the DB unique-per-sim_id constraint blocks the allocation.\n' +
  '          await supabasePatch(\n' +
  '            env,\n' +
  '            `imei_pool?gateway_id=eq.${encodeURIComponent(String(sim.gateway_id))}&port=eq.${encodeURIComponent(sim.port)}&status=eq.in_use`,\n' +
  '            { status: \'retired\', sim_id: null, assigned_at: null, updated_at: new Date().toISOString() }\n' +
  '          );\n' +
  '\n' +
  '          try {\n' +
  '            if (autoImei) {\n' +
  '              // Allocate from pool \u2014 temporarily attach to sim_id\n' +
  '              allocatedEntry = await allocateImeiFromPool(env, sim_id);\n' +
  '              targetImei = allocatedEntry.imei;\n' +
  '              console.log(`[ChangeImei] SIM ${iccid}: auto-allocated IMEI ${targetImei}`);\n' +
  '            }\n' +
  '\n' +
  '            // Check eligibility';

if (!src.includes(OLD1)) {
  console.error('ERROR: OLD1 block not found');
  process.exit(1);
}
src = src.replace(OLD1, NEW1);
console.log('✓ Retirement moved before try/allocate block');

// PART 2: Remove the now-redundant retirement block from inside the try
const OLD2 =
  '            // Retire old in_use IMEI for this slot in the pool\n' +
  '            await supabasePatch(\n' +
  '              env,\n' +
  '              `imei_pool?gateway_id=eq.${encodeURIComponent(String(sim.gateway_id))}&port=eq.${encodeURIComponent(sim.port)}&status=eq.in_use`,\n' +
  '              { status: \'retired\', sim_id: null, assigned_at: null, updated_at: new Date().toISOString() }\n' +
  '            );\n' +
  '\n' +
  '            // Upsert new IMEI in pool as in_use for this slot';

const NEW2 =
  '            // Upsert new IMEI in pool as in_use for this slot';

if (!src.includes(OLD2)) {
  console.error('ERROR: OLD2 block not found');
  process.exit(1);
}
src = src.replace(OLD2, NEW2);
console.log('✓ Removed redundant retirement block from inside try');

// Write with CRLF
const out = src.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, out, 'utf8');
console.log('✓ Written src/mdn-rotator/index.js');
