'use strict';
// Patch: add hxChangeImei call after Resume On Cancel in fixSim()
// Run: node _fix_fixsim_changeimei.js

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src', 'mdn-rotator', 'index.js');
let src = fs.readFileSync(filePath, 'utf8');

// Normalize to LF
src = src.replace(/\r\n/g, '\n');

// Anchor: the comment + supabasePatch call that is currently "step 10"
const MARKER = '    // 10) Update SIM record with new IMEI and pool entry\n    await supabasePatch(';

if (!src.includes(MARKER)) {
  console.error('ERROR: step-10 marker not found');
  process.exit(1);
}

const INSERT =
  '    // 10) Notify Helix of the IMEI change\n' +
  '    console.log(`[FixSim] SIM ${iccid}: notifying Helix of IMEI change (${newImei})`);\n' +
  '    await retryWithBackoff(\n' +
  '      () => hxChangeImei(env, token, subId, newImei, runId, iccid),\n' +
  '      { attempts: 3, label: `changeImei ${iccid}` }\n' +
  '    );\n' +
  '\n' +
  '    // 11) Update SIM record with new IMEI and pool entry\n' +
  '    await supabasePatch(';

src = src.replace(MARKER, INSERT);
console.log('✓ Inserted hxChangeImei call after Resume On Cancel (step 10), renumbered DB update to step 11');

// Write with CRLF
const out = src.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, out, 'utf8');
console.log('✓ Written src/mdn-rotator/index.js');
