// _fix_teltik_debug.js — temporary: add debug counters to billing preview response
const fs = require('fs');
const path = require('path');
const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

const OLD_RESP =
  "    return new Response(JSON.stringify({\n" +
  "      reseller_id: resellerId,\n" +
  "      reseller_name: reseller?.name || resellerId,\n" +
  "      mapping,\n" +
  "      daily_rate: dailyRate,\n" +
  "      block_rate: blockRate,\n" +
  "      days,\n" +
  "      total_sim_days: totalSimDays,\n" +
  "      total_amount: totalAmount,\n" +
  "    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });";

const NEW_RESP =
  "    return new Response(JSON.stringify({\n" +
  "      reseller_id: resellerId,\n" +
  "      reseller_name: reseller?.name || resellerId,\n" +
  "      mapping,\n" +
  "      daily_rate: dailyRate,\n" +
  "      block_rate: blockRate,\n" +
  "      days,\n" +
  "      total_sim_days: totalSimDays,\n" +
  "      total_amount: totalAmount,\n" +
  "      _debug: _dbg,\n" +
  "    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });";

if (!content.includes(OLD_RESP)) { console.error('resp anchor not found'); process.exit(1); }
content = content.replace(OLD_RESP, NEW_RESP);

// Build _dbg before return
const OLD_TOT =
  "    const days = [...attEntries, ...teltikEntries].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);\n" +
  "    const totalSimDays = days.reduce((s, d) => s + d.sim_count, 0);\n" +
  "    const totalAmount = +(days.reduce((s, d) => s + d.amount, 0)).toFixed(2);";

const NEW_TOT =
  "    const days = [...attEntries, ...teltikEntries].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);\n" +
  "    const totalSimDays = days.reduce((s, d) => s + d.sim_count, 0);\n" +
  "    const totalAmount = +(days.reduce((s, d) => s + d.amount, 0)).toFixed(2);\n" +
  "    const _dbg = {\n" +
  "      teltik_sim_ids: teltikSimIds.length,\n" +
  "      rotations_fetched: (typeof rotations !== 'undefined' && Array.isArray(rotations)) ? rotations.length : null,\n" +
  "      teltik_blocks_count: Object.keys(teltikBlocks).reduce((s, k) => s + teltikBlocks[k], 0),\n" +
  "      att_sim_days: Object.keys(attDays).reduce((s, k) => s + attDays[k].size, 0),\n" +
  "    };";

if (!content.includes(OLD_TOT)) { console.error('tot anchor not found'); process.exit(1); }
content = content.replace(OLD_TOT, NEW_TOT);

// Hoist `rotations` so the debug line can see it (declare outside inner if)
const OLD_HOIST =
  "      const rotations = await rotResp.json();\n" +
  "      if (Array.isArray(rotations)) {";
const NEW_HOIST =
  "      rotations = await rotResp.json();\n" +
  "      if (Array.isArray(rotations)) {";
if (content.includes(OLD_HOIST)) content = content.replace(OLD_HOIST, NEW_HOIST);

// Declare rotations var before the if block
const OLD_DECL =
  "    const teltikBlocks = {};\n" +
  "    if (teltikSimIds.length > 0) {";
const NEW_DECL =
  "    const teltikBlocks = {};\n" +
  "    let rotations;\n" +
  "    if (teltikSimIds.length > 0) {";
if (content.includes(OLD_DECL)) content = content.replace(OLD_DECL, NEW_DECL);

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Debug counters added.');
