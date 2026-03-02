// Patch mdn-rotator/index.js and dashboard/index.js:
// - Parse Postgres 23505 unique violations on imei_pool writes
// - Throw/return clear human-readable messages
// - Log to system_errors so they appear in the Errors tab
const fs = require('fs');

// ─── Shared helper text ──────────────────────────────────────────────────────

// Parses a Supabase 409 / 23505 body into a clear message.
// Returns a string on conflict, null otherwise.
const parseConflictFn =
  'function parseImeiPoolConflict(status, bodyText) {\n' +
  '  if (status !== 409 && status !== 422) return null;\n' +
  '  let parsed;\n' +
  '  try { parsed = JSON.parse(bodyText); } catch { return null; }\n' +
  '  if (parsed.code !== \'23505\') return null;\n' +
  '  const msg = parsed.message || \'\';\n' +
  '  const det = parsed.details || \'\';\n' +
  '  if (msg.includes(\'imei_pool_unique_in_use_sim\')) {\n' +
  '    const m = det.match(/sim_id\\)=\\((\\d+)\\)/);\n' +
  '    const simPart = m ? \' (SIM #\' + m[1] + \')\' : \'\';\n' +
  '    return \'IMEI pool conflict: SIM\' + simPart + \' already has an active (in_use) IMEI entry. \' +\n' +
  '           \'The old entry must be retired before assigning a new one. Check the IMEI Pool tab.\';\n' +
  '  }\n' +
  '  if (msg.includes(\'imei_pool_unique_in_use_slot\')) {\n' +
  '    const m = det.match(/gateway_id, port\\)=\\(([^)]+)\\)/);\n' +
  '    const slotPart = m ? \' (gateway/port \' + m[1] + \')\' : \'\';\n' +
  '    return \'IMEI pool conflict: gateway slot\' + slotPart + \' already has an active (in_use) IMEI entry. \' +\n' +
  '           \'The existing slot entry must be retired first. Check the IMEI Pool tab.\';\n' +
  '  }\n' +
  '  return \'IMEI pool unique conflict: \' + (parsed.message || bodyText.slice(0, 200));\n' +
  '}\n';

// ─── Patch 1: mdn-rotator/index.js ──────────────────────────────────────────

const rotatorPath = 'src/mdn-rotator/index.js';
let rotator = fs.readFileSync(rotatorPath, 'utf8').replace(/\r\n/g, '\n');

// 1a) Add parseImeiPoolConflict + logImeiPoolConflict helpers before allocateImeiFromPool
const allocateAnchor = 'async function allocateImeiFromPool(env, simId) {';

const rotatorHelpers =
  parseConflictFn +
  '\n' +
  'async function logImeiPoolConflict(env, message, details) {\n' +
  '  console.error(\'[IMEI Pool Conflict]\', message, details);\n' +
  '  try {\n' +
  '    await fetch(`${env.SUPABASE_URL}/rest/v1/system_errors`, {\n' +
  '      method: \'POST\',\n' +
  '      headers: {\n' +
  '        apikey: env.SUPABASE_SERVICE_ROLE_KEY,\n' +
  '        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,\n' +
  '        \'Content-Type\': \'application/json\',\n' +
  '        Prefer: \'return=minimal\',\n' +
  '      },\n' +
  '      body: JSON.stringify({\n' +
  '        source: \'imei-pool\',\n' +
  '        action: \'duplicate_imei_assignment\',\n' +
  '        error_message: message,\n' +
  '        error_details: details || null,\n' +
  '        severity: \'error\',\n' +
  '        status: \'open\',\n' +
  '      }),\n' +
  '    });\n' +
  '  } catch (e) {\n' +
  '    console.error(\'[IMEI Pool] Failed to log conflict to system_errors:\', e);\n' +
  '  }\n' +
  '}\n\n';

if (!rotator.includes('parseImeiPoolConflict')) {
  rotator = rotator.replace(allocateAnchor, rotatorHelpers + allocateAnchor);
  console.log('✓ Added parseImeiPoolConflict + logImeiPoolConflict to mdn-rotator');
} else {
  console.log('- mdn-rotator helpers already present, skipping');
}

// 1b) Patch first PATCH in allocateImeiFromPool to detect 23505
const allocOld1 =
  '  const txt = await res.text();\n' +
  '  if (!res.ok) throw new Error(`Failed to allocate IMEI: ${res.status} ${txt}`);\n';
const allocNew1 =
  '  const txt = await res.text();\n' +
  '  if (!res.ok) {\n' +
  '    const conflict = parseImeiPoolConflict(res.status, txt);\n' +
  '    if (conflict) {\n' +
  '      await logImeiPoolConflict(env, conflict, { sim_id: simId, pool_entry_id: entry.id, imei: entry.imei });\n' +
  '      throw new Error(conflict);\n' +
  '    }\n' +
  '    throw new Error(`Failed to allocate IMEI: ${res.status} ${txt}`);\n' +
  '  }\n';

if (rotator.includes(allocOld1)) {
  rotator = rotator.replace(allocOld1, allocNew1);
  console.log('✓ Patched allocateImeiFromPool first PATCH conflict check');
} else {
  console.error('✗ allocateImeiFromPool first PATCH error check not found');
  process.exit(1);
}

// 1c) Patch retry PATCH in allocateImeiFromPool
const allocOld2 =
  '    const txt2 = await res2.text();\n' +
  '    if (!res2.ok) throw new Error(`Failed to allocate IMEI (retry): ${res2.status} ${txt2}`);\n';
const allocNew2 =
  '    const txt2 = await res2.text();\n' +
  '    if (!res2.ok) {\n' +
  '      const conflict2 = parseImeiPoolConflict(res2.status, txt2);\n' +
  '      if (conflict2) {\n' +
  '        await logImeiPoolConflict(env, conflict2, { sim_id: simId, pool_entry_id: entry2.id, imei: entry2.imei });\n' +
  '        throw new Error(conflict2);\n' +
  '      }\n' +
  '      throw new Error(`Failed to allocate IMEI (retry): ${res2.status} ${txt2}`);\n' +
  '    }\n';

if (rotator.includes(allocOld2)) {
  rotator = rotator.replace(allocOld2, allocNew2);
  console.log('✓ Patched allocateImeiFromPool retry PATCH conflict check');
} else {
  console.error('✗ allocateImeiFromPool retry PATCH error check not found');
  process.exit(1);
}

fs.writeFileSync(rotatorPath, rotator.replace(/\n/g, '\r\n'));
console.log('✓ mdn-rotator/index.js written\n');

// ─── Patch 2: dashboard/index.js ─────────────────────────────────────────────

const dashPath = 'src/dashboard/index.js';
let dash = fs.readFileSync(dashPath, 'utf8').replace(/\r\n/g, '\n');

// 2a) Add parseImeiPoolConflict helper just before logSystemError
const logSysAnchor = 'async function logSystemError(env, { source, action, sim_id, iccid, error_message, error_details, severity }) {';

if (!dash.includes('parseImeiPoolConflict')) {
  dash = dash.replace(logSysAnchor, parseConflictFn + '\n' + logSysAnchor);
  console.log('✓ Added parseImeiPoolConflict to dashboard');
} else {
  console.log('- dashboard parseImeiPoolConflict already present, skipping');
}

// 2b) Patch set-IMEI intercept upsert — wrap in conflict detection + system_errors log
const setImeiUpsertOld =
  '          // 2. Upsert new IMEI as in_use\n' +
  '          await fetch(`${env.SUPABASE_URL}/rest/v1/imei_pool?on_conflict=imei`, {\n' +
  '            method: \'POST\',\n' +
  '            headers: {\n' +
  '              apikey: env.SUPABASE_SERVICE_ROLE_KEY,\n' +
  '              Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,\n' +
  '              \'Content-Type\': \'application/json\',\n' +
  '              Prefer: \'resolution=merge-duplicates,return=minimal\',\n' +
  '            },\n' +
  '            body: JSON.stringify({\n' +
  '              imei: newImei,\n' +
  '              status: \'in_use\',\n' +
  '              gateway_id: parseInt(gateway_id),\n' +
  '              port: normPort,\n' +
  '              notes: `Manually set via dashboard on ${new Date().toISOString().split(\'T\')[0]}`,\n' +
  '            }),\n' +
  '          });';

const setImeiUpsertNew =
  '          // 2. Upsert new IMEI as in_use\n' +
  '          const upsertRes = await fetch(`${env.SUPABASE_URL}/rest/v1/imei_pool?on_conflict=imei`, {\n' +
  '            method: \'POST\',\n' +
  '            headers: {\n' +
  '              apikey: env.SUPABASE_SERVICE_ROLE_KEY,\n' +
  '              Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,\n' +
  '              \'Content-Type\': \'application/json\',\n' +
  '              Prefer: \'resolution=merge-duplicates,return=minimal\',\n' +
  '            },\n' +
  '            body: JSON.stringify({\n' +
  '              imei: newImei,\n' +
  '              status: \'in_use\',\n' +
  '              gateway_id: parseInt(gateway_id),\n' +
  '              port: normPort,\n' +
  '              notes: `Manually set via dashboard on ${new Date().toISOString().split(\'T\')[0]}`,\n' +
  '            }),\n' +
  '          });\n' +
  '          if (!upsertRes.ok) {\n' +
  '            const upsertTxt = await upsertRes.text();\n' +
  '            const conflict = parseImeiPoolConflict(upsertRes.status, upsertTxt);\n' +
  '            if (conflict) {\n' +
  '              await logSystemError(env, {\n' +
  '                source: \'imei-pool\',\n' +
  '                action: \'set_imei_intercept\',\n' +
  '                error_message: conflict,\n' +
  '                error_details: { gateway_id, port: normPort, imei: newImei },\n' +
  '                severity: \'error\',\n' +
  '              });\n' +
  '              throw new Error(conflict);\n' +
  '            }\n' +
  '            throw new Error(`IMEI pool upsert failed: ${upsertRes.status} ${upsertTxt}`);\n' +
  '          }';

if (dash.includes(setImeiUpsertOld)) {
  dash = dash.replace(setImeiUpsertOld, setImeiUpsertNew);
  console.log('✓ Patched set-IMEI intercept upsert conflict check');
} else {
  console.error('✗ set-IMEI intercept upsert not found');
  process.exit(1);
}

// 2c) Patch handleImportGatewayImeis bulk insert — check for 23505, add to discrepancies
const syncInsertOld =
  '      const insertText = await insertRes.text();\n' +
  '      let insertedArr = [];\n' +
  '      try { insertedArr = JSON.parse(insertText); } catch { }\n' +
  '      inserted = Array.isArray(insertedArr) ? insertedArr.length : 0;\n' +
  '    }';

const syncInsertNew =
  '      const insertText = await insertRes.text();\n' +
  '      let insertedArr = [];\n' +
  '      try { insertedArr = JSON.parse(insertText); } catch { }\n' +
  '      if (!insertRes.ok) {\n' +
  '        const conflict = parseImeiPoolConflict(insertRes.status, insertText);\n' +
  '        const errMsg = conflict || `IMEI pool bulk insert failed: ${insertRes.status} ${insertText.slice(0, 300)}`;\n' +
  '        await logSystemError(env, {\n' +
  '          source: \'imei-pool\',\n' +
  '          action: \'gateway_sync_insert\',\n' +
  '          error_message: errMsg,\n' +
  '          error_details: { gateway_id: gatewayId, attempted: toInsert.length },\n' +
  '          severity: \'error\',\n' +
  '        });\n' +
  '        // Surface in response but don\'t throw — partial success is still useful\n' +
  '        discrepancies.push({ type: \'insert_conflict\', message: errMsg });\n' +
  '      } else {\n' +
  '        inserted = Array.isArray(insertedArr) ? insertedArr.length : 0;\n' +
  '      }\n' +
  '    }';

if (dash.includes(syncInsertOld)) {
  dash = dash.replace(syncInsertOld, syncInsertNew);
  console.log('✓ Patched handleImportGatewayImeis insert conflict check');
} else {
  console.error('✗ handleImportGatewayImeis insert block not found');
  process.exit(1);
}

fs.writeFileSync(dashPath, dash.replace(/\n/g, '\r\n'));
console.log('✓ dashboard/index.js written\n');
console.log('All patches applied.');
