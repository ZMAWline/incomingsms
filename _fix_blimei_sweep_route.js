// _fix_blimei_sweep_route.js
// Adds /api/trigger-blimei-sweep route + handler to dashboard
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

// 1. Add route after /api/imei-sweep
const OLD_ROUTE = `    if (url.pathname === '/api/imei-sweep' && request.method === 'POST') {\n      return handleImeiSweep(env, corsHeaders);\n    }`;
const NEW_ROUTE = OLD_ROUTE + `\n\n    if (url.pathname === '/api/trigger-blimei-sweep' && request.method === 'POST') {\n      return handleTriggerBlimeiSweep(env, corsHeaders);\n    }`;

if (!content.includes(OLD_ROUTE)) {
  console.error('PATCH FAILED: imei-sweep route not found');
  process.exit(1);
}
content = content.replace(OLD_ROUTE, NEW_ROUTE);

// 2. Add function after handleImeiSweep
const OLD_FN_END = `async function handleSimAction(request, env, corsHeaders) {`;
const NEW_FN = `async function handleTriggerBlimeiSweep(env, corsHeaders) {\n  if (!env.MDN_ROTATOR) return new Response(JSON.stringify({ error: 'MDN_ROTATOR not configured' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });\n  if (!env.ADMIN_RUN_SECRET) return new Response(JSON.stringify({ error: 'ADMIN_RUN_SECRET not configured' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });\n  const workerUrl = ` + '`' + `https://mdn-rotator/trigger-blimei-sweep?secret=` + '${' + `encodeURIComponent(env.ADMIN_RUN_SECRET)` + '}' + '`' + `;\n  const workerResponse = await env.MDN_ROTATOR.fetch(workerUrl, { method: 'POST' });\n  const responseText = await workerResponse.text();\n  let result;\n  try { result = JSON.parse(responseText); } catch {\n    result = { ok: false, error: ` + '`' + `Non-JSON response: ` + '${' + `responseText.slice(0, 200)` + '}' + '`' + ` };\n  }\n  return new Response(JSON.stringify(result, null, 2), {\n    status: workerResponse.ok ? 200 : 500,\n    headers: { ...corsHeaders, 'Content-Type': 'application/json' }\n  });\n}\n\n` + OLD_FN_END;

if (!content.includes(OLD_FN_END)) {
  console.error('PATCH FAILED: handleSimAction function marker not found');
  process.exit(1);
}
content = content.replace(OLD_FN_END, NEW_FN);

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch applied successfully.');
