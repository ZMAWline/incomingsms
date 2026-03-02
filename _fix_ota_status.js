'use strict';
const fs = require('fs');
const path = require('path');

// === Patch 1: src/mdn-rotator/index.js ===
const rotatorPath = path.join(__dirname, 'src/mdn-rotator/index.js');
let c = fs.readFileSync(rotatorPath, 'utf8').replace(/\r\n/g, '\n');

let ok = 0;
function patch(label, from, to) {
  if (!c.includes(from)) { console.error('MISS: ' + label); return; }
  c = c.replace(from, to);
  ok++;
  console.log('OK: ' + label);
}

// 1. Add OTA status helper functions after hxOtaRefresh
patch(
  'OTA helpers after hxOtaRefresh',
  '\n  return json;\n}\n\nasync function hxChangeSubscriberStatus',
  '\n  return json;\n}\n\n' +
  '// ===========================\n' +
  '// OTA Status Helpers\n' +
  '// ===========================\n' +
  'function mapHelixStatusToDb(helixStatus) {\n' +
  '  if (!helixStatus) return null;\n' +
  '  const lower = helixStatus.toLowerCase();\n' +
  "  if (lower === 'active') return 'active';\n" +
  "  if (lower === 'suspended') return 'suspended';\n" +
  "  if (lower === 'canceled' || lower === 'cancelled') return 'canceled';\n" +
  '  return null;\n' +
  '}\n\n' +
  'async function updateSimStatusFromOta(env, simId, otaResult) {\n' +
  '  try {\n' +
  '    const fulfilled = otaResult && otaResult.fulfilled;\n' +
  '    if (!Array.isArray(fulfilled) || fulfilled.length === 0) return null;\n' +
  '    const helixStatus = fulfilled[0] && fulfilled[0].status;\n' +
  '    const dbStatus = mapHelixStatusToDb(helixStatus);\n' +
  '    if (!dbStatus) return null;\n' +
  "    await supabasePatch(env, 'sims?id=eq.' + encodeURIComponent(String(simId)), { status: dbStatus });\n" +
  '    return dbStatus;\n' +
  '  } catch (err) {\n' +
  "    console.warn('updateSimStatusFromOta failed for SIM ' + simId + ': ' + err);\n" +
  '    return null;\n' +
  '  }\n' +
  '}\n\n' +
  'async function hxChangeSubscriberStatus'
);

// 2. Modify ota_refresh handler to call updateSimStatusFromOta and include updated_status in response
patch(
  'ota_refresh handler: add status update',
  '          const result = await hxOtaRefresh(env, token, { ban: attBan, subscriberNumber: mdn, iccid }, runId, iccid);\n' +
  '          return new Response(JSON.stringify({ ok: true, action, sim_id, iccid, detail: result }, null, 2), {\n' +
  '            status: 200,\n' +
  '            headers: { "Content-Type": "application/json" }\n' +
  '          });\n' +
  '        }',
  '          const result = await hxOtaRefresh(env, token, { ban: attBan, subscriberNumber: mdn, iccid }, runId, iccid);\n' +
  '          const updatedStatus = await updateSimStatusFromOta(env, sim_id, result);\n' +
  '          return new Response(JSON.stringify({ ok: true, action, sim_id, iccid, detail: result, updated_status: updatedStatus }, null, 2), {\n' +
  '            status: 200,\n' +
  '            headers: { "Content-Type": "application/json" }\n' +
  '          });\n' +
  '        }'
);

// 3. Add queueSimsForOtaStatus and performOtaStatusSync after queueSimsForRotation
patch(
  'add queueSimsForOtaStatus and performOtaStatusSync',
  '  return { ok: true, queued, total: sims.length, manual: isManualRun };\n}\n\n// ===========================\n// Rotate a specific SIM by ICCID',
  '  return { ok: true, queued, total: sims.length, manual: isManualRun };\n}\n\n' +
  '// ===========================\n' +
  '// OTA Status Sync — queue all active/suspended SIMs every 12 hours\n' +
  '// ===========================\n' +
  'async function queueSimsForOtaStatus(env) {\n' +
  '  const sims = await supabaseSelect(env,\n' +
  "    'sims?select=id,iccid,mobility_subscription_id&mobility_subscription_id=not.is.null&status=in.(active,suspended)&order=id.asc&limit=10000'\n" +
  '  );\n' +
  '  if (!Array.isArray(sims) || sims.length === 0) {\n' +
  "    console.log('[OTA Status] No SIMs to sync');\n" +
  "    return { ok: true, queued: 0, message: 'No SIMs to sync' };\n" +
  '  }\n' +
  '  console.log(`[OTA Status] Queuing ${sims.length} SIMs for status sync`);\n' +
  "  const messages = sims.map(sim => ({ body: { type: 'ota_status', id: sim.id, iccid: sim.iccid, mobility_subscription_id: sim.mobility_subscription_id } }));\n" +
  '  let queued = 0;\n' +
  '  for (let i = 0; i < messages.length; i += 100) {\n' +
  '    await env.MDN_QUEUE.sendBatch(messages.slice(i, i + 100));\n' +
  '    queued += Math.min(100, messages.length - i);\n' +
  '  }\n' +
  '  console.log(`[OTA Status] Queued ${queued} SIMs`);\n' +
  '  return { ok: true, queued, total: sims.length };\n' +
  '}\n\n' +
  'async function performOtaStatusSync(env, token, sim) {\n' +
  '  const subId = sim.mobility_subscription_id;\n' +
  '  const iccid = sim.iccid;\n' +
  '  if (!subId) {\n' +
  '    console.log(`[OTA Status] SIM ${iccid} has no subId, skipping`);\n' +
  '    return;\n' +
  '  }\n' +
  '  const runId = `ota_status_${iccid}_${Date.now()}`;\n' +
  '  const details = await hxSubscriberDetails(env, token, subId, runId, iccid);\n' +
  '  const d = Array.isArray(details) ? details[0] : null;\n' +
  '  const subscriberNumber = d && d.phoneNumber;\n' +
  '  const attBan = (d && d.attBan) || (d && d.ban) || null;\n' +
  '  if (!subscriberNumber || !attBan) {\n' +
  '    console.warn(`[OTA Status] SIM ${iccid}: missing phoneNumber or attBan, skipping`);\n' +
  '    return;\n' +
  '  }\n' +
  "  const mdn = String(subscriberNumber).replace(/\\D/g, '').replace(/^1/, '');\n" +
  '  const result = await hxOtaRefresh(env, token, { ban: attBan, subscriberNumber: mdn, iccid }, runId, iccid);\n' +
  '  const updatedStatus = await updateSimStatusFromOta(env, sim.id, result);\n' +
  '  console.log(`[OTA Status] SIM ${iccid}: synced to ${updatedStatus}`);\n' +
  '}\n\n' +
  '// ===========================\n// Rotate a specific SIM by ICCID'
);

// 4. Update scheduled() handler to add 0 and 12 UTC for OTA status sync
patch(
  'scheduled(): add 0 and 12 UTC crons',
  '    if (hour === 5) {\n' +
  '      ctx.waitUntil(queueSimsForRotation(env));\n' +
  '    } else if (hour === 7) {\n' +
  '      ctx.waitUntil(sendErrorSummaryToSlack(env));\n' +
  '    }\n' +
  '  },',
  '    if (hour === 5) {\n' +
  '      ctx.waitUntil(queueSimsForRotation(env));\n' +
  '    } else if (hour === 7) {\n' +
  '      ctx.waitUntil(sendErrorSummaryToSlack(env));\n' +
  '    } else if (hour === 0 || hour === 12) {\n' +
  '      ctx.waitUntil(queueSimsForOtaStatus(env));\n' +
  '    }\n' +
  '  },'
);

// 5. Update queue() consumer to handle ota_status messages
patch(
  'queue(): add ota_status branch',
  '      const attempts = message.attempts || 0;\n\n      try {',
  '      const attempts = message.attempts || 0;\n\n' +
  "      if (sim.type === 'ota_status') {\n" +
  '        try {\n' +
  '          await performOtaStatusSync(env, token, sim);\n' +
  '          message.ack();\n' +
  '          console.log(`SIM ${sim.iccid}: OTA status sync complete`);\n' +
  '        } catch (err) {\n' +
  '          console.error(`SIM ${sim.iccid} OTA status sync failed (attempt ${attempts + 1}): ${err}`);\n' +
  '          if (attempts >= 2) {\n' +
  '            message.ack();\n' +
  '          } else {\n' +
  '            message.retry();\n' +
  '          }\n' +
  '        }\n' +
  '        continue;\n' +
  '      }\n\n' +
  '      try {'
);

// Write back with CRLF
fs.writeFileSync(rotatorPath, c.replace(/\n/g, '\r\n'), 'utf8');
console.log('\n' + ok + '/5 patches applied to mdn-rotator/index.js');
if (ok < 5) process.exit(1);

// === Patch 2: src/dashboard/index.js ===
const dashPath = path.join(__dirname, 'src/dashboard/index.js');
let d = fs.readFileSync(dashPath, 'utf8').replace(/\r\n/g, '\n');

let dOk = 0;
function dpatch(label, from, to) {
  if (!d.includes(from)) { console.error('MISS: ' + label); return; }
  d = d.replace(from, to);
  dOk++;
  console.log('OK: ' + label);
}

// After successful ota_refresh, reload the SIMs table
dpatch(
  'simAction: reload SIMs after ota_refresh',
  '                    loadErrors();\n                } else {',
  '                    loadErrors();\n' +
  '                    if (action === "ota_refresh") loadSims(true);\n' +
  '                } else {'
);

// Write back with CRLF
fs.writeFileSync(dashPath, d.replace(/\n/g, '\r\n'), 'utf8');
console.log(dOk + '/1 patches applied to dashboard/index.js');
if (dOk < 1) process.exit(1);

console.log('\nAll patches applied successfully!');
