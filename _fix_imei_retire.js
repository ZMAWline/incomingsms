// Patch mdn-rotator/index.js and dashboard/index.js to fix orphaned IMEI pool entries
const fs = require('fs');

// ─── Patch 1: mdn-rotator/index.js ──────────────────────────────────────────

const rotatorPath = 'src/mdn-rotator/index.js';
let rotator = fs.readFileSync(rotatorPath, 'utf8').replace(/\r\n/g, '\n');

// 1a) Add retireAllPoolEntriesForSim helper just before retireImeiPoolEntry
const retireHelperAnchor = 'async function retireImeiPoolEntry(env, poolEntryId, simId) {';
const retireHelper =
  'async function retireAllPoolEntriesForSim(env, simId, knownPoolId) {\n' +
  '  // Retire the known current entry first (by current_imei_pool_id)\n' +
  '  if (knownPoolId) {\n' +
  '    await retireImeiPoolEntry(env, knownPoolId, simId);\n' +
  '  }\n' +
  '  // Also retire any orphaned in_use entries where imei_pool.sim_id = simId but\n' +
  '  // sims.current_imei_pool_id was never set (happens with gateway-synced SIMs).\n' +
  '  const query = \'imei_pool?select=id&status=eq.in_use&sim_id=eq.\' +\n' +
  '    encodeURIComponent(String(simId)) +\n' +
  '    (knownPoolId ? \'&id=neq.\' + encodeURIComponent(String(knownPoolId)) : \'\');\n' +
  '  const orphans = await supabaseSelect(env, query);\n' +
  '  for (const entry of (orphans || [])) {\n' +
  '    console.log(\'[IMEI Pool] Retiring orphaned pool entry \' + entry.id + \' for SIM \' + simId);\n' +
  '    await retireImeiPoolEntry(env, entry.id, simId).catch(console.error);\n' +
  '  }\n' +
  '}\n\n';

if (!rotator.includes('retireAllPoolEntriesForSim')) {
  rotator = rotator.replace(retireHelperAnchor, retireHelper + retireHelperAnchor);
  console.log('✓ Added retireAllPoolEntriesForSim helper');
} else {
  console.log('- retireAllPoolEntriesForSim already present, skipping');
}

// 1b) Patch fixSim — replace 4-line old retirement block
const fixSimOld =
  '  // 2) Retire old IMEI pool entry — IMEIs removed from a slot are never reused\n' +
  '  const oldPoolId = sim.current_imei_pool_id;\n' +
  '  if (oldPoolId) {\n' +
  '    await retireImeiPoolEntry(env, oldPoolId, simId);\n' +
  '  }';
const fixSimNew =
  '  // 2) Retire old IMEI pool entry — also sweeps orphaned entries where\n' +
  '  //    current_imei_pool_id was never set (gateway-synced SIMs).\n' +
  '  await retireAllPoolEntriesForSim(env, simId, sim.current_imei_pool_id);';

if (rotator.includes(fixSimOld)) {
  rotator = rotator.replace(fixSimOld, fixSimNew);
  console.log('✓ Patched fixSim retirement');
} else {
  console.error('✗ fixSim retirement block not found — check manually');
  process.exit(1);
}

// 1c) Patch retryActivation — replace single-line old retirement
const retryOld =
  '  if (sim.current_imei_pool_id) await retireImeiPoolEntry(env, sim.current_imei_pool_id, simId);';
const retryNew =
  '  // Retire old entry + sweep orphaned in_use entries\n' +
  '  await retireAllPoolEntriesForSim(env, simId, sim.current_imei_pool_id);';

if (rotator.includes(retryOld)) {
  rotator = rotator.replace(retryOld, retryNew);
  console.log('✓ Patched retryActivation retirement');
} else {
  console.error('✗ retryActivation retirement line not found — check manually');
  process.exit(1);
}

fs.writeFileSync(rotatorPath, rotator.replace(/\n/g, '\r\n'));
console.log('✓ mdn-rotator/index.js written');

// ─── Patch 2: dashboard/index.js — backfill sims.current_imei_pool_id on sync ─

const dashPath = 'src/dashboard/index.js';
let dash = fs.readFileSync(dashPath, 'utf8').replace(/\r\n/g, '\n');

// Find the "Link sim_id on imei_pool entries" loop and extend it to also
// backfill sims.current_imei_pool_id where it is currently NULL.
const linkLoopOld =
  '    // Link sim_id on imei_pool entries for active SIM slots\n' +
  '    let linked = 0;\n' +
  '    for (const entry of simImeiMap) {\n' +
  '      try {\n' +
  '        const linkRes = await fetch(\n' +
  '          `${env.SUPABASE_URL}/rest/v1/imei_pool?imei=eq.${encodeURIComponent(entry.imei)}`,\n' +
  '          {\n' +
  '            method: \'PATCH\',\n' +
  '            headers: {\n' +
  '              apikey: env.SUPABASE_SERVICE_ROLE_KEY,\n' +
  '              Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,\n' +
  '              \'Content-Type\': \'application/json\',\n' +
  '              Prefer: \'return=minimal\',\n' +
  '            },\n' +
  '            body: JSON.stringify({ sim_id: entry.sim_id }),\n' +
  '          }\n' +
  '        );\n' +
  '        if (linkRes.ok) linked++;\n' +
  '      } catch { }\n' +
  '    }';

const linkLoopNew =
  '    // Link sim_id on imei_pool entries for active SIM slots,\n' +
  '    // and backfill sims.current_imei_pool_id where not set.\n' +
  '    let linked = 0;\n' +
  '    let backfilledCurrentPool = 0;\n' +
  '    for (const entry of simImeiMap) {\n' +
  '      try {\n' +
  '        const linkRes = await fetch(\n' +
  '          `${env.SUPABASE_URL}/rest/v1/imei_pool?imei=eq.${encodeURIComponent(entry.imei)}`,\n' +
  '          {\n' +
  '            method: \'PATCH\',\n' +
  '            headers: {\n' +
  '              apikey: env.SUPABASE_SERVICE_ROLE_KEY,\n' +
  '              Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,\n' +
  '              \'Content-Type\': \'application/json\',\n' +
  '              Prefer: \'return=representation\',\n' +
  '            },\n' +
  '            body: JSON.stringify({ sim_id: entry.sim_id }),\n' +
  '          }\n' +
  '        );\n' +
  '        if (linkRes.ok) {\n' +
  '          linked++;\n' +
  '          // Backfill sims.current_imei_pool_id if not set\n' +
  '          try {\n' +
  '            const poolRows = await linkRes.json();\n' +
  '            const poolId = Array.isArray(poolRows) && poolRows[0]?.id;\n' +
  '            if (poolId) {\n' +
  '              const simPatch = await fetch(\n' +
  '                `${env.SUPABASE_URL}/rest/v1/sims?id=eq.${encodeURIComponent(String(entry.sim_id))}&current_imei_pool_id=is.null`,\n' +
  '                {\n' +
  '                  method: \'PATCH\',\n' +
  '                  headers: {\n' +
  '                    apikey: env.SUPABASE_SERVICE_ROLE_KEY,\n' +
  '                    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,\n' +
  '                    \'Content-Type\': \'application/json\',\n' +
  '                    Prefer: \'return=minimal\',\n' +
  '                  },\n' +
  '                  body: JSON.stringify({ current_imei_pool_id: poolId }),\n' +
  '                }\n' +
  '              );\n' +
  '              if (simPatch.ok) backfilledCurrentPool++;\n' +
  '            }\n' +
  '          } catch { }\n' +
  '        }\n' +
  '      } catch { }\n' +
  '    }';

if (dash.includes(linkLoopOld)) {
  dash = dash.replace(linkLoopOld, linkLoopNew);
  console.log('✓ Patched handleImportGatewayImeis to backfill current_imei_pool_id');
} else {
  console.error('✗ gateway sync link loop not found — check manually');
  process.exit(1);
}

// Also add backfilledCurrentPool to the response JSON
const respOld =
  '      linked_to_sims: linked,\n' +
  '    }), { headers: { ...corsHeaders, \'Content-Type\': \'application/json\' } });';
const respNew =
  '      linked_to_sims: linked,\n' +
  '      backfilled_current_pool: backfilledCurrentPool,\n' +
  '    }), { headers: { ...corsHeaders, \'Content-Type\': \'application/json\' } });';

if (dash.includes(respOld)) {
  dash = dash.replace(respOld, respNew);
  console.log('✓ Added backfilled_current_pool to sync response');
} else {
  console.error('✗ sync response object not found — check manually');
  process.exit(1);
}

fs.writeFileSync(dashPath, dash.replace(/\n/g, '\r\n'));
console.log('✓ dashboard/index.js written');

console.log('\nAll patches applied successfully.');
