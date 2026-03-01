'use strict';
// Fix: when running OTA refresh, sync DB status if Helix status differs.
// Run: node _fix_ota_status_sync.js

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src', 'mdn-rotator', 'index.js');
let src = fs.readFileSync(filePath, 'utf8');

src = src.replace(/\r\n/g, '\n');

// 1) Add 'status' to the SIM select in the sim-action handler
const OLD1 =
  '`sims?select=id,iccid,mobility_subscription_id,gateway_id,port&id=eq.${encodeURIComponent(String(sim_id))}&limit=1`';
const NEW1 =
  '`sims?select=id,iccid,mobility_subscription_id,gateway_id,port,status&id=eq.${encodeURIComponent(String(sim_id))}&limit=1`';

if (!src.includes(OLD1)) {
  console.error('ERROR: SIM select not found');
  process.exit(1);
}
src = src.replace(OLD1, NEW1);
console.log('\u2713 Added status to SIM select');

// 2) Replace the ota_refresh handler to sync status before running OTA
const OLD2 =
  '        if (action === "ota_refresh") {\n' +
  '          if (!attBan) {\n' +
  '            return new Response(JSON.stringify({ ok: false, error: `No attBan for SIM ${iccid}, cannot OTA refresh` }), {\n' +
  '              status: 400,\n' +
  '              headers: { "Content-Type": "application/json" }\n' +
  '            });\n' +
  '          }\n' +
  '          const result = await hxOtaRefresh(env, token, { ban: attBan, subscriberNumber: mdn, iccid }, runId, iccid);\n' +
  '          return new Response(JSON.stringify({ ok: true, action, sim_id, iccid, detail: result }, null, 2), {\n' +
  '            status: 200,\n' +
  '            headers: { "Content-Type": "application/json" }\n' +
  '          });\n' +
  '        }';

const NEW2 =
  '        if (action === "ota_refresh") {\n' +
  '          if (!attBan) {\n' +
  '            return new Response(JSON.stringify({ ok: false, error: `No attBan for SIM ${iccid}, cannot OTA refresh` }), {\n' +
  '              status: 400,\n' +
  '              headers: { "Content-Type": "application/json" }\n' +
  '            });\n' +
  '          }\n' +
  '          // Sync status if Helix differs from DB\n' +
  '          const helixStatusMap = { Active: "active", Suspended: "suspended", Canceled: "canceled" };\n' +
  '          const helixStatus = helixStatusMap[d?.status] || null;\n' +
  '          let statusUpdated = null;\n' +
  '          if (helixStatus && helixStatus !== sim.status) {\n' +
  '            console.log(`[OTA] SIM ${iccid}: status mismatch DB=${sim.status} Helix=${helixStatus} — updating`);\n' +
  '            await supabasePatch(env, `sims?id=eq.${encodeURIComponent(String(sim_id))}`, { status: helixStatus });\n' +
  '            statusUpdated = { from: sim.status, to: helixStatus };\n' +
  '          }\n' +
  '          const result = await hxOtaRefresh(env, token, { ban: attBan, subscriberNumber: mdn, iccid }, runId, iccid);\n' +
  '          return new Response(JSON.stringify({ ok: true, action, sim_id, iccid, status_updated: statusUpdated, detail: result }, null, 2), {\n' +
  '            status: 200,\n' +
  '            headers: { "Content-Type": "application/json" }\n' +
  '          });\n' +
  '        }';

if (!src.includes(OLD2)) {
  console.error('ERROR: ota_refresh handler not found');
  process.exit(1);
}
src = src.replace(OLD2, NEW2);
console.log('\u2713 OTA refresh handler now syncs status if Helix differs from DB');

const out = src.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, out, 'utf8');
console.log('\u2713 Written src/mdn-rotator/index.js');
