// _fix_billing_paginate.js
// Paginate reseller_sims queries in both billing handlers (Supabase silently
// caps at 1000 rows regardless of &limit). Also remove temporary _debug field.

const fs = require('fs');
const path = require('path');
const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

// ---------- 1. Add supabaseGetAllArray helper below supabaseGet ----------
const HELPER_ANCHOR =
  "async function supabaseGet(env, path) {\n" +
  "  return fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {\n" +
  "    headers: {\n" +
  "      apikey: env.SUPABASE_SERVICE_ROLE_KEY,\n" +
  "      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,\n" +
  "      Accept: 'application/json',\n" +
  "    },\n" +
  "  });\n" +
  "}\n";

const HELPER_ADDED =
  HELPER_ANCHOR +
  "\n" +
  "async function supabaseGetAllArray(env, pathWithoutLimit) {\n" +
  "  const pageSize = 1000;\n" +
  "  const out = [];\n" +
  "  for (let offset = 0; ; offset += pageSize) {\n" +
  "    const sep = pathWithoutLimit.includes('?') ? '&' : '?';\n" +
  "    const url = pathWithoutLimit + sep + 'limit=' + pageSize + '&offset=' + offset;\n" +
  "    const resp = await supabaseGet(env, url);\n" +
  "    if (!resp.ok) {\n" +
  "      const txt = await resp.text();\n" +
  "      throw new Error('PostgREST fetch failed: ' + resp.status + ' ' + txt);\n" +
  "    }\n" +
  "    const batch = await resp.json();\n" +
  "    if (!Array.isArray(batch)) return batch;\n" +
  "    out.push(...batch);\n" +
  "    if (batch.length < pageSize) break;\n" +
  "  }\n" +
  "  return out;\n" +
  "}\n";

if (!content.includes(HELPER_ANCHOR)) {
  console.error('PATCH FAILED: supabaseGet anchor not found');
  process.exit(1);
}
if (content.includes('async function supabaseGetAllArray(')) {
  console.log('supabaseGetAllArray helper already present — skipping.');
} else {
  content = content.replace(HELPER_ANCHOR, HELPER_ADDED);
}

// ---------- 2. handleBillingPreview reseller_sims fetch ----------
const PREVIEW_OLD =
  "    const smsResp = await supabaseGet(env,\n" +
  "      'reseller_sims?select=sim_id,sims(vendor,rotation_interval_hours,sim_sms_daily(est_date,sms_count))' +\n" +
  "      '&reseller_id=eq.' + encodeURIComponent(resellerId) +\n" +
  "      '&active=eq.true' +\n" +
  "      '&limit=5000'\n" +
  "    );\n" +
  "    const rsSims = await smsResp.json();\n";

const PREVIEW_NEW =
  "    const rsSims = await supabaseGetAllArray(env,\n" +
  "      'reseller_sims?select=sim_id,sims(vendor,rotation_interval_hours,sim_sms_daily(est_date,sms_count))' +\n" +
  "      '&reseller_id=eq.' + encodeURIComponent(resellerId) +\n" +
  "      '&active=eq.true' +\n" +
  "      '&order=sim_id.asc'\n" +
  "    );\n";

// There are two occurrences with the same exact OLD text (handleBillingPreview + handleBillingDownloadInvoice)
const count = content.split(PREVIEW_OLD).length - 1;
if (count !== 2) {
  console.error('PATCH FAILED: expected 2 occurrences of reseller_sims fetch, got ' + count);
  process.exit(1);
}
content = content.split(PREVIEW_OLD).join(PREVIEW_NEW);

// ---------- 3. Remove _debug, hoisted `let rotations;`, and inline declaration ----------
const DBG_DECL_OLD =
  "    const teltikBlocks = {};\n" +
  "    let rotations;\n" +
  "    if (teltikSimIds.length > 0) {";
const DBG_DECL_NEW =
  "    const teltikBlocks = {};\n" +
  "    if (teltikSimIds.length > 0) {";
if (content.includes(DBG_DECL_OLD)) {
  content = content.replace(DBG_DECL_OLD, DBG_DECL_NEW);
}

const DBG_ROTS_OLD = "      rotations = await rotResp.json();\n";
const DBG_ROTS_NEW = "      const rotations = await rotResp.json();\n";
if (content.includes(DBG_ROTS_OLD)) {
  content = content.replace(DBG_ROTS_OLD, DBG_ROTS_NEW);
}

const DBG_BLOCK_OLD =
  "    const totalAmount = +(days.reduce((s, d) => s + d.amount, 0)).toFixed(2);\n" +
  "    const _dbg = {\n" +
  "      teltik_sim_ids: teltikSimIds.length,\n" +
  "      rotations_fetched: (typeof rotations !== 'undefined' && Array.isArray(rotations)) ? rotations.length : null,\n" +
  "      teltik_blocks_count: Object.keys(teltikBlocks).reduce((s, k) => s + teltikBlocks[k], 0),\n" +
  "      att_sim_days: Object.keys(attDays).reduce((s, k) => s + attDays[k].size, 0),\n" +
  "    };\n" +
  "\n" +
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

const DBG_BLOCK_NEW =
  "    const totalAmount = +(days.reduce((s, d) => s + d.amount, 0)).toFixed(2);\n" +
  "\n" +
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

if (content.includes(DBG_BLOCK_OLD)) {
  content = content.replace(DBG_BLOCK_OLD, DBG_BLOCK_NEW);
} else {
  console.log('Debug block not present (already clean?) — skipping.');
}

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch applied: pagination helper + 2 reseller_sims fetches updated + debug stripped.');
