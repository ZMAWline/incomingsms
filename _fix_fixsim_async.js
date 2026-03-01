'use strict';
// Fix: run fixSim via ctx.waitUntil() so the fix action returns immediately
// instead of waiting 40+ seconds and hitting the service-binding timeout.
// Run: node _fix_fixsim_async.js

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src', 'mdn-rotator', 'index.js');
let src = fs.readFileSync(filePath, 'utf8');

src = src.replace(/\r\n/g, '\n');

// 1) Add ctx to the fetch handler signature
const OLD1 = '  async fetch(request, env) {';
const NEW1 = '  async fetch(request, env, ctx) {';

if (!src.includes(OLD1)) {
  console.error('ERROR: fetch signature not found');
  process.exit(1);
}
src = src.replace(OLD1, NEW1);
console.log('\u2713 Added ctx to fetch handler signature');

// 2) Replace the fix action block with a ctx.waitUntil version
const OLD2 =
  '        // For fix, delegate directly\n' +
  '        if (action === "fix") {\n' +
  '          const token = await getCachedToken(env);\n' +
  '          const result = await fixSim(env, token, sim_id, { autoRotate: false });\n' +
  '          return new Response(JSON.stringify({ ok: true, action, sim_id, iccid, detail: result }, null, 2), {\n' +
  '            status: 200,\n' +
  '            headers: { "Content-Type": "application/json" }\n' +
  '          });\n' +
  '        }';

const NEW2 =
  '        // For fix, run in background via ctx.waitUntil to avoid the ~40s\n' +
  '        // service-binding timeout. Returns immediately; results appear in Helix API Logs.\n' +
  '        if (action === "fix") {\n' +
  '          const token = await getCachedToken(env);\n' +
  '          ctx.waitUntil(\n' +
  '            fixSim(env, token, sim_id, { autoRotate: false }).catch(err => {\n' +
  '              console.error("[SimAction/fix] background error:", err);\n' +
  '            })\n' +
  '          );\n' +
  '          return new Response(JSON.stringify({\n' +
  '            ok: true,\n' +
  '            running: true,\n' +
  '            message: "Fix started \u2014 this takes ~40 seconds. Check the Helix API Logs below to confirm each step completed.",\n' +
  '            action, sim_id, iccid\n' +
  '          }, null, 2), {\n' +
  '            status: 200,\n' +
  '            headers: { "Content-Type": "application/json" }\n' +
  '          });\n' +
  '        }';

if (!src.includes(OLD2)) {
  console.error('ERROR: fix action block not found');
  process.exit(1);
}
src = src.replace(OLD2, NEW2);
console.log('\u2713 fix action now uses ctx.waitUntil and returns immediately');

const out = src.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, out, 'utf8');
console.log('\u2713 Written src/mdn-rotator/index.js');
