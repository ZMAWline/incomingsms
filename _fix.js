const fs = require('fs');

// ============================================================
// FIX 1: skyline-gateway — add all_slots support to handlePortInfo
// ============================================================
let gw = fs.readFileSync('src/skyline-gateway/index.js', 'utf8');

const gwOld = '    ports: "all",\r\n  });\r\n\r\n  const infoUrl = `http://${gateway.host}';
const gwNew = '    ports: "all",\r\n  });\r\n\r\n  // Support all_slots=1 to get IMEIs from every SIM slot (multi-slot gateways)\r\n  if (url.searchParams.get("all_slots") === "1") {\r\n    params.set("all_slots", "1");\r\n  }\r\n\r\n  const infoUrl = `http://${gateway.host}';

if (!gw.includes(gwOld)) { console.error('ERROR: skyline-gateway marker not found'); process.exit(1); }
gw = gw.replace(gwOld, gwNew);
fs.writeFileSync('src/skyline-gateway/index.js', gw, 'utf8');
console.log('OK: skyline-gateway — all_slots support added');

// ============================================================
// FIX 2: dashboard — rewrite handleImportGatewayImeis completely
// ============================================================
let dash = fs.readFileSync('src/dashboard/index.js', 'utf8');

const dashOld = 'async function handleImportGatewayImeis(request, env, corsHeaders) {';
const dashEnd = '}\r\n\r\nfunction getHTML() {';

const startIdx = dash.indexOf(dashOld);
const endIdx = dash.indexOf(dashEnd, startIdx);
if (startIdx === -1 || endIdx === -1) { console.error('ERROR: dashboard markers not found', startIdx, endIdx); process.exit(1); }

// Replace everything from the function start up to (but not including) "function getHTML()"
const replacement = `async function handleImportGatewayImeis(request, env, corsHeaders) {\r
  try {\r
    const body = await request.json();\r
    const gatewayId = body.gateway_id;\r
\r
    if (!gatewayId) {\r
      return new Response(JSON.stringify({ error: 'gateway_id is required' }), {\r
        status: 400,\r
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }\r
      });\r
    }\r
\r
    if (!env.SKYLINE_GATEWAY) {\r
      return new Response(JSON.stringify({ error: 'SKYLINE_GATEWAY service binding not configured' }), {\r
        status: 500,\r
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }\r
      });\r
    }\r
\r
    if (!env.SKYLINE_SECRET) {\r
      return new Response(JSON.stringify({ error: 'SKYLINE_SECRET not configured' }), {\r
        status: 500,\r
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }\r
      });\r
    }\r
\r
    // Fetch all port data with all_slots=1 to get every IMEI (including inactive slots on multi-SIM gateways)\r
    const infoParams = new URLSearchParams({\r
      gateway_id: gatewayId,\r
      secret: env.SKYLINE_SECRET,\r
      all_slots: '1',\r
    });\r
    const infoRes = await env.SKYLINE_GATEWAY.fetch(\r
      \`https://skyline-gateway/port-info?\${infoParams}\`,\r
      { method: 'GET' }\r
    );\r
    const infoText = await infoRes.text();\r
    let infoData;\r
    try { infoData = JSON.parse(infoText); } catch {\r
      return new Response(JSON.stringify({ error: \`Non-JSON from skyline-gateway: \${infoText.slice(0, 200)}\` }), {\r
        status: 502,\r
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }\r
      });\r
    }\r
\r
    if (!infoData.ok) {\r
      return new Response(JSON.stringify({ error: infoData.error || 'Gateway returned error', detail: infoData }), {\r
        status: 502,\r
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }\r
      });\r
    }\r
\r
    const ports = infoData.ports || [];\r
    const totalPorts = ports.length;\r
\r
    // Extract unique, valid IMEIs (15 digits)\r
    const seen = new Set();\r
    const toInsert = [];\r
    let skippedNoImei = 0;\r
    // Track ICCID->IMEI mapping for backfilling sims.imei\r
    const iccidImeiMap = [];\r
\r
    for (const p of ports) {\r
      const imei = (p.imei || '').trim();\r
      if (!imei || !/^\\d{15}$/.test(imei)) {\r
        skippedNoImei++;\r
        continue;\r
      }\r
      if (!seen.has(imei)) {\r
        seen.add(imei);\r
        toInsert.push({\r
          imei,\r
          status: 'available',\r
          notes: \`Imported from gateway \${gatewayId} port \${p.port}\${p.iccid ? ' iccid=' + p.iccid : ''}\`,\r
        });\r
      }\r
      // For active slots with an ICCID, record the mapping to backfill sims.imei\r
      if (p.iccid && p.sim_id) {\r
        iccidImeiMap.push({ sim_id: p.sim_id, imei });\r
      }\r
    }\r
\r
    if (toInsert.length === 0) {\r
      return new Response(JSON.stringify({\r
        ok: true, added: 0, duplicates: 0,\r
        skipped_no_imei: skippedNoImei, total_ports: totalPorts,\r
        message: 'No valid IMEIs found on this gateway',\r
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });\r
    }\r
\r
    // Bulk insert into imei_pool, ignoring duplicates\r
    const insertRes = await fetch(\`\${env.SUPABASE_URL}/rest/v1/imei_pool\`, {\r
      method: 'POST',\r
      headers: {\r
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,\r
        Authorization: \`Bearer \${env.SUPABASE_SERVICE_ROLE_KEY}\`,\r
        'Content-Type': 'application/json',\r
        Prefer: 'resolution=ignore-duplicates,return=representation',\r
      },\r
      body: JSON.stringify(toInsert),\r
    });\r
\r
    const insertText = await insertRes.text();\r
    let inserted = [];\r
    try { inserted = JSON.parse(insertText); } catch {}\r
\r
    const added = Array.isArray(inserted) ? inserted.length : 0;\r
    const duplicates = toInsert.length - added;\r
\r
    // Backfill sims.imei for active slots that have a matched sim_id\r
    let backfilled = 0;\r
    for (const entry of iccidImeiMap) {\r
      try {\r
        const patchRes = await fetch(\r
          \`\${env.SUPABASE_URL}/rest/v1/sims?id=eq.\${encodeURIComponent(String(entry.sim_id))}&imei=is.null\`,\r
          {\r
            method: 'PATCH',\r
            headers: {\r
              apikey: env.SUPABASE_SERVICE_ROLE_KEY,\r
              Authorization: \`Bearer \${env.SUPABASE_SERVICE_ROLE_KEY}\`,\r
              'Content-Type': 'application/json',\r
              Prefer: 'return=minimal',\r
            },\r
            body: JSON.stringify({ imei: entry.imei }),\r
          }\r
        );\r
        if (patchRes.ok) backfilled++;\r
      } catch {}\r
    }\r
\r
    return new Response(JSON.stringify({\r
      ok: true, total_ports: totalPorts,\r
      skipped_no_imei: skippedNoImei, found: toInsert.length,\r
      added, duplicates, backfilled_sims: backfilled,\r
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });\r
\r
  } catch (error) {\r
    return new Response(JSON.stringify({ error: String(error) }), {\r
      status: 500,\r
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }\r
    });\r
  }\r
}\r
\r
`;

dash = dash.slice(0, startIdx) + replacement + dash.slice(endIdx);
fs.writeFileSync('src/dashboard/index.js', dash, 'utf8');
console.log('OK: dashboard — handleImportGatewayImeis rewritten with secret + all_slots + backfill');
