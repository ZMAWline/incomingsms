import { readFileSync, writeFileSync } from 'fs';

const path = 'src/dashboard/index.js';
let src = readFileSync(path, 'utf8');

// 1) Add route after the /api/imei-sweep route
const routeAnchor = `    if (url.pathname === '/api/imei-sweep' && request.method === 'POST') {\r\n      return handleImeiSweep(env, corsHeaders);\r\n    }`;
const routeInsert = `\r\n\r\n    if (url.pathname === '/api/imei-gateway-sync' && request.method === 'POST') {\r\n      return handleImeiGatewaySync(request, env, corsHeaders);\r\n    }`;
if (!src.includes(routeAnchor)) { console.error('Route anchor not found'); process.exit(1); }
if (src.includes('/api/imei-gateway-sync')) { console.log('Route already exists, skipping route insert'); }
else { src = src.replace(routeAnchor, routeAnchor + routeInsert); }

// 2) Add handleImeiGatewaySync function after handleImeiSweep
const fnAnchor = `async function handleImeiSweep(env, corsHeaders) {`;
const newFn = `async function handleImeiGatewaySync(request, env, corsHeaders) {\r\n  if (!env.MDN_ROTATOR) return new Response(JSON.stringify({ error: 'MDN_ROTATOR not configured' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });\r\n  if (!env.ADMIN_RUN_SECRET) return new Response(JSON.stringify({ error: 'ADMIN_RUN_SECRET not configured' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });\r\n\r\n  let body;\r\n  try { body = await request.json(); } catch {\r\n    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });\r\n  }\r\n\r\n  const workerUrl = \`https://mdn-rotator/imei-gateway-sync?secret=\${encodeURIComponent(env.ADMIN_RUN_SECRET)}\`;\r\n  const workerResponse = await env.MDN_ROTATOR.fetch(workerUrl, {\r\n    method: 'POST',\r\n    headers: { 'Content-Type': 'application/json' },\r\n    body: JSON.stringify(body),\r\n  });\r\n  const responseText = await workerResponse.text();\r\n  let result;\r\n  try { result = JSON.parse(responseText); } catch {\r\n    result = { ok: false, error: \`Non-JSON response: \${responseText.slice(0, 200)}\` };\r\n  }\r\n  return new Response(JSON.stringify(result, null, 2), {\r\n    status: workerResponse.ok ? 200 : 500,\r\n    headers: { ...corsHeaders, 'Content-Type': 'application/json' }\r\n  });\r\n}\r\n\r\n`;

if (!src.includes(fnAnchor)) { console.error('Function anchor not found'); process.exit(1); }
if (src.includes('handleImeiGatewaySync')) { console.log('Function already exists, skipping fn insert'); }
else { src = src.replace(fnAnchor, newFn + fnAnchor); }

writeFileSync(path, src);
console.log('Done.');
