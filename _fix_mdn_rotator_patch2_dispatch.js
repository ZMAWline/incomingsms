// PATCH 2 of 2 — rotateSingleSim vendor dispatch, ISOLATED.
// Touches only the head of rotateSingleSim:
//   - Hoist dedup check above vendor branch (applies to all vendors)
//   - Add explicit vendor dispatch:
//       atomic   → delegate to existing rotateAtomicSim(env, sim)
//       wing_iot → log + early-return (defense-in-depth; cron query already excludes them)
//       teltik   → log + early-return (defense-in-depth; cron query already excludes them)
//       helix    → existing logic (default, unchanged)
// Does NOT touch the helix rotation body, rotateAtomicSim, queueSimsForRotation, or any helper.
// CRLF-safe: normalize-edit-restore.

const fs = require('fs');
const path = require('path');

const file = path.join('src', 'mdn-rotator', 'index.js');
const raw = fs.readFileSync(file, 'utf8');
const isCRLF = raw.includes('\r\n');
let src = raw.replace(/\r\n/g, '\n');
const before = src;

const oldHead =
  'async function rotateSingleSim(env, token, sim) {\n' +
  '  const subId = sim.mobility_subscription_id;\n' +
  '  const iccid = sim.iccid;\n' +
  '\n' +
  '  if (!subId) {\n' +
  '    console.log(`SIM ${iccid}: no mobility_subscription_id, skipping`);\n' +
  '    return;\n' +
  '  }\n' +
  '\n' +
  '  // Dedup check: skip if already rotated today (catches duplicate queue messages from multi-cron)\n' +
  '  const todayMidnightEst = getNYMidnightISO();\n' +
  '  if (sim.last_mdn_rotated_at && sim.last_mdn_rotated_at >= todayMidnightEst) {\n' +
  '    console.log(`SIM ${iccid}: already rotated today (${sim.last_mdn_rotated_at}), skipping duplicate queue message`);\n' +
  '    return;\n' +
  '  }\n' +
  '  // Re-check current DB value (queue message may be stale from an earlier cron run)\n' +
  '  const freshSim = await supabaseSelectOne(env, `sims?id=eq.${encodeURIComponent(String(sim.id))}&select=last_mdn_rotated_at`);\n' +
  '  if (freshSim && freshSim.last_mdn_rotated_at && freshSim.last_mdn_rotated_at >= todayMidnightEst) {\n' +
  '    console.log(`SIM ${iccid}: DB confirms already rotated today (${freshSim.last_mdn_rotated_at}), skipping`);\n' +
  '    return;\n' +
  '  }';

const newHead =
  'async function rotateSingleSim(env, token, sim) {\n' +
  '  const iccid = sim.iccid;\n' +
  '  const vendor = sim.vendor || \'helix\';\n' +
  '\n' +
  '  // Dedup check: skip if already rotated today (catches duplicate queue messages from multi-cron).\n' +
  '  // Hoisted above the vendor dispatch so it applies to every vendor uniformly.\n' +
  '  const todayMidnightEst = getNYMidnightISO();\n' +
  '  if (sim.last_mdn_rotated_at && sim.last_mdn_rotated_at >= todayMidnightEst) {\n' +
  '    console.log(`SIM ${iccid} (${vendor}): already rotated today (${sim.last_mdn_rotated_at}), skipping duplicate queue message`);\n' +
  '    return;\n' +
  '  }\n' +
  '  // Re-check current DB value (queue message may be stale from an earlier cron run)\n' +
  '  const freshSim = await supabaseSelectOne(env, `sims?id=eq.${encodeURIComponent(String(sim.id))}&select=last_mdn_rotated_at`);\n' +
  '  if (freshSim && freshSim.last_mdn_rotated_at && freshSim.last_mdn_rotated_at >= todayMidnightEst) {\n' +
  '    console.log(`SIM ${iccid} (${vendor}): DB confirms already rotated today (${freshSim.last_mdn_rotated_at}), skipping`);\n' +
  '    return;\n' +
  '  }\n' +
  '\n' +
  '  // Vendor dispatch.\n' +
  '  // - atomic: delegate to rotateAtomicSim (defined elsewhere in this file)\n' +
  '  // - wing_iot / teltik: explicit early-return (defense-in-depth; the cron\n' +
  '  //   query in queueSimsForRotation already filters these out, so reaching\n' +
  '  //   here means a stray queue message — log loudly, do not fall through to\n' +
  '  //   the helix code path)\n' +
  '  // - helix: fall through to the original logic below (default)\n' +
  '  if (vendor === \'atomic\') {\n' +
  '    return await rotateAtomicSim(env, sim);\n' +
  '  }\n' +
  '  if (vendor === \'wing_iot\') {\n' +
  '    console.log(`SIM ${iccid}: wing_iot rotation not implemented in mdn-rotator yet — skipping (queue message should not have reached here; check queueSimsForRotation)`);\n' +
  '    return;\n' +
  '  }\n' +
  '  if (vendor === \'teltik\') {\n' +
  '    console.log(`SIM ${iccid}: teltik handled by teltik-worker — skipping (queue message should not have reached here; check queueSimsForRotation)`);\n' +
  '    return;\n' +
  '  }\n' +
  '\n' +
  '  // ---- Helix path (default) ----\n' +
  '  const subId = sim.mobility_subscription_id;\n' +
  '  if (!subId) {\n' +
  '    console.log(`SIM ${iccid}: no mobility_subscription_id, skipping`);\n' +
  '    return;\n' +
  '  }';

if (!src.includes(oldHead)) {
  console.error('ERROR: could not find rotateSingleSim head block (verify whitespace)');
  process.exit(1);
}
src = src.replace(oldHead, newHead);

if (src === before) {
  console.error('ERROR: no replacements made');
  process.exit(1);
}

const out = isCRLF ? src.replace(/\n/g, '\r\n') : src;
fs.writeFileSync(file, out, 'utf8');
console.log('Patch 2 applied (CRLF: ' + isCRLF + ').');
console.log('  - rotateSingleSim: dedup hoisted, vendor dispatch added');
console.log('  - atomic → rotateAtomicSim, wing_iot/teltik → early-return, helix → unchanged default');
