'use strict';
const fs = require('fs');
const path = require('path');

// Revert all OTA status sync changes from mdn-rotator/index.js
const rotatorPath = path.join(__dirname, 'src/mdn-rotator/index.js');
let c = fs.readFileSync(rotatorPath, 'utf8').replace(/\r\n/g, '\n');

let ok = 0;
function patch(label, from, to) {
  if (!c.includes(from)) { console.error('MISS: ' + label); return; }
  c = c.replace(from, to);
  ok++;
  console.log('OK: ' + label);
}

// 1. Remove OTA helpers (mapHelixStatusToDb + updateSimStatusFromOta)
patch(
  'remove OTA helpers',
  '\n// ===========================\n' +
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
  '}\n\n',
  '\n'
);

// 2. Revert ota_refresh handler (remove updatedStatus line, restore original return)
patch(
  'revert ota_refresh handler',
  '          const result = await hxOtaRefresh(env, token, { ban: attBan, subscriberNumber: mdn, iccid }, runId, iccid);\n' +
  '          const updatedStatus = await updateSimStatusFromOta(env, sim_id, result);\n' +
  '          return new Response(JSON.stringify({ ok: true, action, sim_id, iccid, detail: result, updated_status: updatedStatus }, null, 2), {\n' +
  '            status: 200,\n' +
  '            headers: { "Content-Type": "application/json" }\n' +
  '          });\n' +
  '        }',
  '          const result = await hxOtaRefresh(env, token, { ban: attBan, subscriberNumber: mdn, iccid }, runId, iccid);\n' +
  '          return new Response(JSON.stringify({ ok: true, action, sim_id, iccid, detail: result }, null, 2), {\n' +
  '            status: 200,\n' +
  '            headers: { "Content-Type": "application/json" }\n' +
  '          });\n' +
  '        }'
);

// 3. Remove queueSimsForOtaStatus and performOtaStatusSync functions
patch(
  'remove queueSimsForOtaStatus and performOtaStatusSync',
  '\n// ===========================\n' +
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
  '}\n\n',
  '\n'
);

// 4. Revert scheduled() handler (remove 0 and 12 UTC branch)
patch(
  'revert scheduled() handler',
  '    if (hour === 5) {\n' +
  '      ctx.waitUntil(queueSimsForRotation(env));\n' +
  '    } else if (hour === 7) {\n' +
  '      ctx.waitUntil(sendErrorSummaryToSlack(env));\n' +
  '    } else if (hour === 0 || hour === 12) {\n' +
  '      ctx.waitUntil(queueSimsForOtaStatus(env));\n' +
  '    }\n' +
  '  },',
  '    if (hour === 5) {\n' +
  '      ctx.waitUntil(queueSimsForRotation(env));\n' +
  '    } else if (hour === 7) {\n' +
  '      ctx.waitUntil(sendErrorSummaryToSlack(env));\n' +
  '    }\n' +
  '  },'
);

// 5. Revert queue() consumer (remove ota_status branch)
patch(
  'revert queue() consumer',
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
  '      try {',
  '      const attempts = message.attempts || 0;\n\n      try {'
);

// Write back with CRLF
fs.writeFileSync(rotatorPath, c.replace(/\n/g, '\r\n'), 'utf8');
console.log('\n' + ok + '/5 reverts applied to mdn-rotator/index.js');
if (ok < 5) process.exit(1);
console.log('Revert complete.');
