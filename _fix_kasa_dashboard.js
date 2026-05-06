// _fix_kasa_dashboard.js — add KASA power control to gateway tab
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

// ── Patch 1: add /api/kasa/ route ──────────────────────────────────────────
const R1_OLD = "    if (url.pathname === '/api/fix-sim') {";
const R1_NEW =
  "    if (url.pathname.startsWith('/api/kasa/')) {\n" +
  "      return handleKasaProxy(request, env, url, corsHeaders);\n" +
  "    }\n\n" +
  "    if (url.pathname === '/api/fix-sim') {";

if (!content.includes(R1_OLD)) { console.error('PATCH 1 FAILED: anchor not found'); process.exit(1); }
content = content.replace(R1_OLD, R1_NEW);
console.log('Patch 1 OK (route)');

// ── Patch 2: add handleKasaProxy function before handleGateways ────────────
const R2_OLD = "\nasync function handleGateways(request, env, corsHeaders) {";
const R2_NEW =
  "\nasync function handleKasaProxy(request, env, url, corsHeaders) {\n" +
  "  if (!env.KASA_CONTROL) {\n" +
  "    return new Response(JSON.stringify({error: 'KASA_CONTROL not configured'}), {\n" +
  "      status: 503,\n" +
  "      headers: { ...corsHeaders, 'Content-Type': 'application/json' }\n" +
  "    });\n" +
  "  }\n" +
  "  const kasaPath = url.pathname.replace('/api/kasa', '');\n" +
  "  const kasaReq = new Request('https://kasa-control.workers.dev' + kasaPath, {\n" +
  "    method: request.method,\n" +
  "    headers: { 'Content-Type': 'application/json' },\n" +
  "    body: (request.method !== 'GET' && request.method !== 'HEAD') ? request.body : undefined,\n" +
  "  });\n" +
  "  try {\n" +
  "    const res = await env.KASA_CONTROL.fetch(kasaReq);\n" +
  "    const body = await res.text();\n" +
  "    return new Response(body, {\n" +
  "      status: res.status,\n" +
  "      headers: { ...corsHeaders, 'Content-Type': 'application/json' },\n" +
  "    });\n" +
  "  } catch(err) {\n" +
  "    return new Response(JSON.stringify({error: String(err)}), {\n" +
  "      status: 500,\n" +
  "      headers: { ...corsHeaders, 'Content-Type': 'application/json' },\n" +
  "    });\n" +
  "  }\n" +
  "}\n\n" +
  "async function handleGateways(request, env, corsHeaders) {";

if (!content.includes(R2_OLD)) { console.error('PATCH 2 FAILED: anchor not found'); process.exit(1); }
content = content.replace(R2_OLD, R2_NEW);
console.log('Patch 2 OK (handleKasaProxy)');

// ── Patch 3: add Power Control section in gateway tab ─────────────────────
const R3_OLD =
  "                </div>\n" +
  "            </div>\n" +
  "\n" +
  "            <!-- IMEI Pool Tab -->";

const R3_NEW =
  "                </div>\n\n" +
  "                <!-- Power Control -->\n" +
  "                <div class=\"bg-dark-800 rounded-xl border border-dark-600 mt-6\">\n" +
  "                    <div class=\"px-5 py-4 border-b border-dark-600 flex items-center justify-between\">\n" +
  "                        <div>\n" +
  "                            <h2 class=\"text-lg font-semibold text-white\">Power Control</h2>\n" +
  "                            <p class=\"text-xs text-gray-500 mt-0.5\">Union Office &#8212; TP-Link Strip</p>\n" +
  "                        </div>\n" +
  "                        <button onclick=\"loadKasaOutlets()\" id=\"kasa-refresh-btn\" class=\"px-3 py-1.5 text-xs bg-dark-700 border border-dark-500 rounded-lg text-gray-300 hover:bg-dark-600 transition\">Refresh</button>\n" +
  "                    </div>\n" +
  "                    <div id=\"kasa-outlets\" class=\"p-5\">\n" +
  "                        <p class=\"text-gray-500 text-sm text-center py-4\">Click Refresh to load outlet states</p>\n" +
  "                    </div>\n" +
  "                </div>\n" +
  "            </div>\n" +
  "\n" +
  "            <!-- IMEI Pool Tab -->";

if (!content.includes(R3_OLD)) { console.error('PATCH 3 FAILED: anchor not found'); process.exit(1); }
content = content.replace(R3_OLD, R3_NEW);
console.log('Patch 3 OK (Power Control HTML)');

// ── Patch 4: insert JS functions before End D3 comment (positional) ────────
// Use data-alias + data-action attributes to avoid nested quote escaping inside getHTML template literal.
const endD3Idx = content.indexOf('// \u2500\u2500 End D3');
if (endD3Idx === -1) { console.error('PATCH 4 FAILED: End D3 comment not found'); process.exit(1); }
const insertPos = content.lastIndexOf('\n', endD3Idx) + 1;

// Note: double-quotes inside strings below are fine inside the outer getHTML template literal.
// Single quotes used for JS string delimiters to avoid conflicts.
// data-alias/data-action avoids any nested quoting issues in onclick.
const R4_INSERT =
  "        function kasaKick(el) { kasaControl(el.dataset.alias, el.dataset.action); }\n\n" +
  "        async function loadKasaOutlets() {\n" +
  "            var btn = document.getElementById('kasa-refresh-btn');\n" +
  "            var container = document.getElementById('kasa-outlets');\n" +
  "            if (btn) btn.disabled = true;\n" +
  "            container.innerHTML = '<p class=\"text-gray-500 text-sm text-center py-4\">Loading...</p>';\n" +
  "            try {\n" +
  "                var res = await fetch('/api/kasa/outlets');\n" +
  "                var outlets = await res.json();\n" +
  "                if (!res.ok) throw new Error(outlets.error || 'Failed to load');\n" +
  "                if (!outlets.length) {\n" +
  "                    container.innerHTML = '<p class=\"text-gray-500 text-sm text-center py-4\">No outlets found</p>';\n" +
  "                    return;\n" +
  "                }\n" +
  "                container.innerHTML = outlets.map(function(o) {\n" +
  "                    var on = o.state;\n" +
  "                    var a = o.alias;\n" +
  "                    return '<div class=\"flex items-center justify-between p-3 rounded-lg bg-dark-700 border border-dark-500 mb-2\">' +\n" +
  "                        '<div class=\"flex items-center gap-3\">' +\n" +
  "                        '<div class=\"w-2.5 h-2.5 rounded-full ' + (on ? 'bg-green-400' : 'bg-gray-600') + '\"></div>' +\n" +
  "                        '<span class=\"text-sm text-gray-200 font-medium\">' + a + '</span>' +\n" +
  "                        '<span class=\"text-xs px-1.5 py-0.5 rounded ' + (on ? 'bg-green-900/50 text-green-400' : 'bg-gray-700 text-gray-500') + '\">' + (on ? 'ON' : 'OFF') + '</span>' +\n" +
  "                        '</div>' +\n" +
  "                        '<div class=\"flex gap-2\">' +\n" +
  "                        '<button data-alias=\"' + a + '\" data-action=\"on\" onclick=\"kasaKick(this)\" class=\"px-2 py-1 text-xs bg-green-700 hover:bg-green-600 text-white rounded transition\"' + (on ? ' disabled style=\"opacity:0.5\"' : '') + '>On</button>' +\n" +
  "                        '<button data-alias=\"' + a + '\" data-action=\"off\" onclick=\"kasaKick(this)\" class=\"px-2 py-1 text-xs bg-red-700 hover:bg-red-600 text-white rounded transition\"' + (!on ? ' disabled style=\"opacity:0.5\"' : '') + '>Off</button>' +\n" +
  "                        '<button data-alias=\"' + a + '\" data-action=\"reboot\" onclick=\"kasaKick(this)\" class=\"px-2 py-1 text-xs bg-orange-700 hover:bg-orange-600 text-white rounded transition\">Reboot</button>' +\n" +
  "                        '</div></div>';\n" +
  "                }).join('');\n" +
  "            } catch(e) {\n" +
  "                container.innerHTML = '<p class=\"text-red-400 text-sm text-center py-4\">' + e.message + '</p>';\n" +
  "            } finally {\n" +
  "                if (btn) btn.disabled = false;\n" +
  "            }\n" +
  "        }\n\n" +
  "        async function kasaControl(alias, action) {\n" +
  "            if (action === 'reboot') {\n" +
  "                if (!await showConfirm('Reboot outlet ' + alias + '? This will power-cycle it (10s off).')) return;\n" +
  "            }\n" +
  "            var label = action === 'reboot' ? 'Rebooting' : action === 'on' ? 'Turning on' : 'Turning off';\n" +
  "            showToast(label + ' ' + alias + '...', 'info');\n" +
  "            try {\n" +
  "                var res = await fetch('/api/kasa/outlet', {\n" +
  "                    method: 'POST',\n" +
  "                    headers: {'Content-Type': 'application/json'},\n" +
  "                    body: JSON.stringify({alias: alias, action: action})\n" +
  "                });\n" +
  "                var data = await res.json();\n" +
  "                if (!res.ok) throw new Error(data.error || 'Failed');\n" +
  "                showToast(alias + ': ' + action + ' successful', 'success');\n" +
  "                await loadKasaOutlets();\n" +
  "            } catch(e) {\n" +
  "                showToast('Error: ' + e.message, 'error');\n" +
  "            }\n" +
  "        }\n\n";

content = content.slice(0, insertPos) + R4_INSERT + content.slice(insertPos);
console.log('Patch 4 OK (JS functions)');

// ── Write back ─────────────────────────────────────────────────────────────
content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('All patches applied successfully.');
