// PATCH 1 of 2 — Cron query widening, ISOLATED.
// Touches only queueSimsForRotation:
//   - widens query from vendor=eq.helix to vendor=neq.teltik
//   - adds client-side per-vendor identifier filter (helix: subId, atomic: msisdn)
//   - wing_iot SIMs naturally fall out (no rotation logic in this worker yet)
// Does NOT touch rotateSingleSim, rotateSpecificSim, or any other function.
// CRLF-safe: normalize-edit-restore.

const fs = require('fs');
const path = require('path');

const file = path.join('src', 'mdn-rotator', 'index.js');
const raw = fs.readFileSync(file, 'utf8');
const isCRLF = raw.includes('\r\n');
let src = raw.replace(/\r\n/g, '\n');
const before = src;

// --- Change 1a: widen the query ---
const oldQuery =
  '  let query = `sims?select=id,iccid,mobility_subscription_id,status,last_mdn_rotated_at,reseller_sims!inner(reseller_id)&reseller_sims.active=eq.true&mobility_subscription_id=not.is.null&status=eq.active&vendor=eq.helix`;';

const newQuery =
  '  // Include rotation-eligible vendors (helix, atomic). Exclude teltik (handled by\n' +
  '  // teltik-worker on its own 48h cadence) and wing_iot (no rotation logic yet —\n' +
  '  // Wing IoT SIMs are filtered out client-side via the identifier check below).\n' +
  '  // Identifier requirement enforced client-side: helix needs mobility_subscription_id,\n' +
  '  // atomic needs msisdn.\n' +
  '  let query = `sims?select=id,iccid,mobility_subscription_id,msisdn,vendor,status,last_mdn_rotated_at,reseller_sims!inner(reseller_id)&reseller_sims.active=eq.true&status=eq.active&vendor=neq.teltik`;';

if (!src.includes(oldQuery)) {
  console.error('ERROR: could not find queueSimsForRotation query line');
  process.exit(1);
}
src = src.replace(oldQuery, newQuery);

// --- Change 1b: add client-side identifier filter ---
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

if (src === before) {
  console.error('ERROR: no replacements made');
  process.exit(1);
}

const out = isCRLF ? src.replace(/\n/g, '\r\n') : src;
fs.writeFileSync(file, out, 'utf8');
console.log('Patch 1 applied (CRLF: ' + isCRLF + ').');
console.log('  - queueSimsForRotation query: vendor=eq.helix → vendor=neq.teltik');
console.log('  - Added per-vendor identifier filter (helix: subId, atomic: msisdn)');
