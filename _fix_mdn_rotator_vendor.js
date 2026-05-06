// CRLF-safe patch: normalize to LF, do replacements, restore CRLF on write.

const fs = require('fs');
const path = require('path');

const file = path.join('src', 'mdn-rotator', 'index.js');
const raw = fs.readFileSync(file, 'utf8');
const isCRLF = raw.includes('\r\n');
let src = raw.replace(/\r\n/g, '\n');
const before = src;

// -----------------------------------------------------------------------------
// CHANGE 1a: queueSimsForRotation — widen the query
// -----------------------------------------------------------------------------

const oldQuery =
  '  let query = `sims?select=id,iccid,mobility_subscription_id,status,last_mdn_rotated_at,reseller_sims!inner(reseller_id)&reseller_sims.active=eq.true&mobility_subscription_id=not.is.null&status=eq.active&vendor=eq.helix`;';

const newQuery =
  '  // Include all rotation-eligible vendors (helix, atomic). Exclude teltik\n' +
  '  // (handled by teltik-worker on its own 48h cadence) and wing_iot (no rotation\n' +
  '  // path implemented here yet — Wing IoT SIMs are filtered out client-side via\n' +
  '  // the identifier check below).\n' +
  '  // Identifier requirement is enforced client-side per vendor: helix needs\n' +
  '  // mobility_subscription_id, atomic needs msisdn.\n' +
  '  let query = `sims?select=id,iccid,mobility_subscription_id,msisdn,vendor,status,last_mdn_rotated_at,reseller_sims!inner(reseller_id)&reseller_sims.active=eq.true&status=eq.active&vendor=neq.teltik`;';

if (!src.includes(oldQuery)) {
  console.error('ERROR: could not find queueSimsForRotation old query line');
  process.exit(1);
}
src = src.replace(oldQuery, newQuery);

// -----------------------------------------------------------------------------
// CHANGE 1b: queueSimsForRotation — add client-side identifier filter
// -----------------------------------------------------------------------------

const oldSelect =
  '  const sims = await supabaseSelect(env, query);\n' +
  '\n' +
  '  if (!Array.isArray(sims) || sims.length === 0) {\n' +
  '    console.log("No active SIMs found.");\n' +
  '    return { ok: true, queued: 0, message: "No SIMs to rotate" };\n' +
  '  }';

const newSelect =
  '  const rawSims = await supabaseSelect(env, query);\n' +
  '\n' +
  '  // Per-vendor identifier filter (PostgREST OR is awkward, so filter in JS).\n' +
  '  // Wing IoT SIMs have no msisdn/subId in DB and fall out here — intentional\n' +
  '  // until Wing rotation is wired into this worker.\n' +
  '  const sims = (Array.isArray(rawSims) ? rawSims : []).filter(s => {\n' +
  '    const v = s.vendor || \'helix\';\n' +
  '    if (v === \'helix\') return !!s.mobility_subscription_id;\n' +
  '    if (v === \'atomic\') return !!s.msisdn;\n' +
  '    return false;\n' +
  '  });\n' +
  '\n' +
  '  if (sims.length === 0) {\n' +
  '    console.log("No active SIMs eligible for rotation (vendor/identifier filter).");\n' +
  '    return { ok: true, queued: 0, message: "No SIMs to rotate" };\n' +
  '  }';

if (!src.includes(oldSelect)) {
  console.error('ERROR: could not find queueSimsForRotation supabaseSelect block');
  process.exit(1);
}
src = src.replace(oldSelect, newSelect);

// -----------------------------------------------------------------------------
// CHANGE 2: rotateSingleSim — hoist dedup + vendor dispatch
// -----------------------------------------------------------------------------

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
  '  // Hoisted above the vendor dispatch so it applies to all vendors.\n' +
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
  '  // Vendor-aware dispatch\n' +
  '  if (vendor === \'atomic\') {\n' +
  '    return await rotateAtomicSim(env, sim);\n' +
  '  }\n' +
  '  if (vendor === \'wing_iot\') {\n' +
  '    console.log(`SIM ${iccid}: wing_iot rotation not implemented in mdn-rotator yet, skipping`);\n' +
  '    return;\n' +
  '  }\n' +
  '  if (vendor === \'teltik\') {\n' +
  '    console.log(`SIM ${iccid}: teltik handled by teltik-worker, skipping (should not reach here)`);\n' +
  '    return;\n' +
  '  }\n' +
  '\n' +
  '  // Helix path (default)\n' +
  '  const subId = sim.mobility_subscription_id;\n' +
  '  if (!subId) {\n' +
  '    console.log(`SIM ${iccid}: no mobility_subscription_id, skipping`);\n' +
  '    return;\n' +
  '  }';

if (!src.includes(oldHead)) {
  console.error('ERROR: could not find rotateSingleSim head block');
  process.exit(1);
}
src = src.replace(oldHead, newHead);

if (src === before) {
  console.error('ERROR: no replacements made');
  process.exit(1);
}

// Restore line endings
const out = isCRLF ? src.replace(/\n/g, '\r\n') : src;
fs.writeFileSync(file, out, 'utf8');
console.log('mdn-rotator/index.js patched successfully (CRLF preserved: ' + isCRLF + ')');
console.log('  - queueSimsForRotation: vendor=eq.helix → vendor=neq.teltik + identifier filter');
console.log('  - rotateSingleSim: dedup hoisted, vendor dispatch added (atomic → rotateAtomicSim)');
