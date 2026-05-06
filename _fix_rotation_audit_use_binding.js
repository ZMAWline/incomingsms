// Use DETAILS_FINALIZER service binding instead of bare fetch (Workers can't
// reach .workers.dev URLs of other Workers via the public network — error 1042).
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

const OLD =
  "    if (!env.FINALIZER_RUN_SECRET) {\n" +
  "      return new Response(JSON.stringify({ error: 'FINALIZER_RUN_SECRET not configured on dashboard worker' }), {\n" +
  "        status: 500,\n" +
  "        headers: { ...corsHeaders, 'Content-Type': 'application/json' }\n" +
  "      });\n" +
  "    }\n" +
  "    const url = 'https://details-finalizer.zalmen-531.workers.dev/reconcile-rotations?secret=' + encodeURIComponent(env.FINALIZER_RUN_SECRET) + '&force=1';\n" +
  "    const r = await fetch(url, { method: 'GET' });\n";

const NEW =
  "    if (!env.FINALIZER_RUN_SECRET) {\n" +
  "      return new Response(JSON.stringify({ error: 'FINALIZER_RUN_SECRET not configured on dashboard worker' }), {\n" +
  "        status: 500,\n" +
  "        headers: { ...corsHeaders, 'Content-Type': 'application/json' }\n" +
  "      });\n" +
  "    }\n" +
  "    if (!env.DETAILS_FINALIZER) {\n" +
  "      return new Response(JSON.stringify({ error: 'DETAILS_FINALIZER service binding not configured' }), {\n" +
  "        status: 500,\n" +
  "        headers: { ...corsHeaders, 'Content-Type': 'application/json' }\n" +
  "      });\n" +
  "    }\n" +
  "    const url = 'https://details-finalizer/reconcile-rotations?secret=' + encodeURIComponent(env.FINALIZER_RUN_SECRET) + '&force=1';\n" +
  "    const r = await env.DETAILS_FINALIZER.fetch(url, { method: 'GET' });\n";

if (!content.includes(OLD)) {
  console.error('PATCH FAILED: OLD not found');
  process.exit(1);
}
content = content.replace(OLD, NEW);

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch applied: handleRotationAuditRun now uses DETAILS_FINALIZER service binding.');
