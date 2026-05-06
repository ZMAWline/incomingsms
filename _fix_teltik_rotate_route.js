// _fix_teltik_rotate_route.js
// Dashboard backend: handleSimAction now looks up the SIM's vendor and routes
// teltik rotate calls to the TELTIK_WORKER service binding instead of the
// mdn-rotator (which rejects teltik). All other actions still go to mdn-rotator.
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

const OLD =
  "async function handleSimAction(request, env, corsHeaders) {\n" +
  "  try {\n" +
  "    const body = await request.json();\n" +
  "    const { sim_id, action } = body;\n" +
  "    if (!sim_id || !action) return new Response(JSON.stringify({ error: 'sim_id and action required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });\n" +
  "\n" +
  "    if (!env.MDN_ROTATOR) return new Response(JSON.stringify({ error: 'MDN_ROTATOR not configured' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });\n" +
  "    if (!env.ADMIN_RUN_SECRET) return new Response(JSON.stringify({ error: 'ADMIN_RUN_SECRET not configured' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });\n" +
  "\n" +
  "    const workerUrl = `https://mdn-rotator/sim-action?secret=${encodeURIComponent(env.ADMIN_RUN_SECRET)}`;\n" +
  "    const workerResponse = await env.MDN_ROTATOR.fetch(workerUrl, {\n" +
  "      method: 'POST',\n" +
  "      headers: { 'Content-Type': 'application/json' },\n" +
  "      body: JSON.stringify({ sim_id, action, gateway_id: body.gateway_id ?? null, port: body.port ?? null, new_imei: body.new_imei ?? null, auto_imei: body.auto_imei ?? false, imei_strategy: body.imei_strategy ?? null, force: body.force === true })\n" +
  "    });";

const NEW =
  "async function handleSimAction(request, env, corsHeaders) {\n" +
  "  try {\n" +
  "    const body = await request.json();\n" +
  "    const { sim_id, action } = body;\n" +
  "    if (!sim_id || !action) return new Response(JSON.stringify({ error: 'sim_id and action required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });\n" +
  "\n" +
  "    if (!env.ADMIN_RUN_SECRET) return new Response(JSON.stringify({ error: 'ADMIN_RUN_SECRET not configured' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });\n" +
  "\n" +
  "    // Teltik rotate is handled by teltik-worker, not mdn-rotator. Look up vendor first.\n" +
  "    if (action === 'rotate') {\n" +
  "      const vendorRes = await supabaseGet(env, `sims?select=iccid,vendor&id=eq.${encodeURIComponent(String(sim_id))}&limit=1`);\n" +
  "      const vendorRows = await vendorRes.json().catch(() => []);\n" +
  "      const row = Array.isArray(vendorRows) && vendorRows[0] ? vendorRows[0] : null;\n" +
  "      if (row && row.vendor === 'teltik') {\n" +
  "        if (!env.TELTIK_WORKER) return new Response(JSON.stringify({ ok: false, error: 'TELTIK_WORKER not configured' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });\n" +
  "        const tUrl = `https://teltik-worker/rotate-sim?secret=${encodeURIComponent(env.ADMIN_RUN_SECRET)}&iccid=${encodeURIComponent(row.iccid)}&force=${body.force === true ? 'true' : 'false'}`;\n" +
  "        const tRes = await env.TELTIK_WORKER.fetch(tUrl, { method: 'POST' });\n" +
  "        const tText = await tRes.text();\n" +
  "        let tResult; try { tResult = JSON.parse(tText); } catch { tResult = { ok: false, error: `Non-JSON response: ${tText.slice(0, 200)}` }; }\n" +
  "        if (!tResult.ok && tResult.error) {\n" +
  "          await logSystemError(env, { source: 'dashboard', action: 'rotate', sim_id, error_message: tResult.error, error_details: { vendor: 'teltik', response: tResult, status: tRes.status } });\n" +
  "        }\n" +
  "        return new Response(JSON.stringify({ ok: tResult.ok, action, sim_id, iccid: row.iccid, forced: body.force === true, vendor: 'teltik', detail: tResult }, null, 2), { status: tRes.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });\n" +
  "      }\n" +
  "    }\n" +
  "\n" +
  "    if (!env.MDN_ROTATOR) return new Response(JSON.stringify({ error: 'MDN_ROTATOR not configured' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });\n" +
  "\n" +
  "    const workerUrl = `https://mdn-rotator/sim-action?secret=${encodeURIComponent(env.ADMIN_RUN_SECRET)}`;\n" +
  "    const workerResponse = await env.MDN_ROTATOR.fetch(workerUrl, {\n" +
  "      method: 'POST',\n" +
  "      headers: { 'Content-Type': 'application/json' },\n" +
  "      body: JSON.stringify({ sim_id, action, gateway_id: body.gateway_id ?? null, port: body.port ?? null, new_imei: body.new_imei ?? null, auto_imei: body.auto_imei ?? false, imei_strategy: body.imei_strategy ?? null, force: body.force === true })\n" +
  "    });";

if (!content.includes(OLD)) {
  console.error('PATCH FAILED: old string not found.');
  process.exit(1);
}
content = content.replace(OLD, NEW);

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch applied.');
