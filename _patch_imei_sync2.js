import { readFileSync, writeFileSync } from 'fs';

const path = 'src/dashboard/index.js';
let src = readFileSync(path, 'utf8');

// Add handleImeiGatewaySync function before handleImeiSweep
const fnAnchor = `async function handleImeiSweep(env, corsHeaders) {`;
const newFn = `async function handleImeiGatewaySync(request, env, corsHeaders) {\r\n  if (!env.MDN_ROTATOR) return new Response(JSON.stringify({ error: 'MDN_ROTATOR not configured' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });\r\n  if (!env.ADMIN_RUN_SECRET) return new Response(JSON.stringify({ error: 'ADMIN_RUN_SECRET not configured' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });\r\n\r\n  let body;\r\n  try { body = await request.json(); } catch {\r\n    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });\r\n  }\r\n\r\n  const workerUrl = \`https://mdn-rotator/imei-gateway-sync?secret=\${encodeURIComponent(env.ADMIN_RUN_SECRET)}\`;\r\n  const workerResponse = await env.MDN_ROTATOR.fetch(workerUrl, {\r\n    method: 'POST',\r\n    headers: { 'Content-Type': 'application/json' },\r\n    body: JSON.stringify(body),\r\n  });\r\n  const responseText = await workerResponse.text();\r\n  let result;\r\n  try { result = JSON.parse(responseText); } catch {\r\n    result = { ok: false, error: \`Non-JSON response: \${responseText.slice(0, 200)}\` };\r\n  }\r\n  return new Response(JSON.stringify(result, null, 2), {\r\n    status: workerResponse.ok ? 200 : 500,\r\n    headers: { ...corsHeaders, 'Content-Type': 'application/json' }\r\n  });\r\n}\r\n\r\n`;

if (!src.includes(fnAnchor)) { console.error('Anchor not found'); process.exit(1); }
// check fn doesn't already exist (proper check: look for the function definition, not just the call)
if (src.includes('async function handleImeiGatewaySync')) {
  console.log('Function already defined, nothing to do.');
  process.exit(0);
}
src = src.replace(fnAnchor, newFn + fnAnchor);
writeFileSync(path, src);
console.log('Done.');
