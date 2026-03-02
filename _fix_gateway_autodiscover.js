// Patch: if SIM has no gateway_id/port, auto-scan gateways and persist before fix continues.
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src', 'mdn-rotator', 'index.js');
let src = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');

const OLD =
  '  if (!subId) throw new Error(`SIM ${iccid}: no mobility_subscription_id`);\n' +
  '  if (!sim.gateway_id) throw new Error(`SIM ${iccid}: no gateway_id`);\n' +
  '  if (!sim.port) throw new Error(`SIM ${iccid}: no port`);\n' +
  '\n' +
  '  console.log(`[FixSim] Starting for SIM ${simId} (${iccid})`);';

if (!src.includes(OLD)) {
  console.error('Cannot find gateway_id check block'); process.exit(1);
}

const NEW =
  '  if (!subId) throw new Error(`SIM ${iccid}: no mobility_subscription_id`);\n' +
  '\n' +
  '  // Auto-discover gateway/port if not set on SIM record\n' +
  '  if (!sim.gateway_id || !sim.port) {\n' +
  '    console.log(`[FixSim] SIM ${iccid}: no gateway_id/port — scanning gateways...`);\n' +
  '    const found = await scanGatewaysForIccid(env, iccid);\n' +
  '    if (!found) throw new Error(`SIM ${iccid}: no gateway_id/port set and ICCID not found on any gateway`);\n' +
  '    sim.gateway_id = found.gateway_id;\n' +
  '    sim.port = found.port;\n' +
  '    console.log(`[FixSim] SIM ${iccid}: discovered gateway_id=${sim.gateway_id} port=${sim.port}`);\n' +
  '    // Persist so future operations have it\n' +
  '    await supabasePatch(env, `sims?id=eq.${encodeURIComponent(String(simId))}`, {\n' +
  '      gateway_id: sim.gateway_id,\n' +
  '      port: sim.port,\n' +
  '    });\n' +
  '  }\n' +
  '\n' +
  '  console.log(`[FixSim] Starting for SIM ${simId} (${iccid})`);';

src = src.replace(OLD, NEW);

fs.writeFileSync(filePath, src.replace(/\n/g, '\r\n'), 'utf8');
console.log('Patch applied successfully.');
