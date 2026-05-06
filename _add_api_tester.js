'use strict';
const fs = require('fs');
const path = require('path');
const filePath = path.join(__dirname, 'src', 'dashboard', 'index.js');

let content = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');

// ── Change 1: Backend route ──────────────────────────────────────────────────
const routeAnchor = '    // Serve HTML dashboard for all non-API paths (SPA routing)';
if (!content.includes(routeAnchor)) throw new Error('Route anchor not found');
content = content.replace(routeAnchor,
  '    if (url.pathname === \'/api/relay-test\' && request.method === \'POST\') {\n' +
  '      return handleRelayTest(request, env, corsHeaders);\n' +
  '    }\n\n' +
  routeAnchor
);
console.log('✓ Route added');

// ── Change 2: Backend handleRelayTest function ───────────────────────────────
const getHtmlAnchor = 'function getHTML()';
if (!content.includes(getHtmlAnchor)) throw new Error('getHTML anchor not found');
const handlerFn =
  'async function handleRelayTest(request, env, corsHeaders) {\n' +
  '  try {\n' +
  '    const body = await request.json();\n' +
  '    const method = (body.method || \'GET\').toUpperCase();\n' +
  '    const url = body.url;\n' +
  '    const headers = body.headers || {};\n' +
  '    const reqBody = body.body;\n' +
  '    if (!url) {\n' +
  '      return new Response(JSON.stringify({ error: \'url is required\' }), { status: 400, headers: { ...corsHeaders, \'Content-Type\': \'application/json\' } });\n' +
  '    }\n' +
  '    const init = { method, headers };\n' +
  '    if (reqBody !== null && reqBody !== undefined) {\n' +
  '      init.body = typeof reqBody === \'string\' ? reqBody : JSON.stringify(reqBody);\n' +
  '    }\n' +
  '    const resp = await relayFetch(env, url, init);\n' +
  '    const respBody = await resp.text();\n' +
  '    const respHeaders = {};\n' +
  '    resp.headers.forEach(function(val, key) { respHeaders[key] = val; });\n' +
  '    return new Response(JSON.stringify({ ok: true, status: resp.status, headers: respHeaders, body: respBody }), {\n' +
  '      headers: { ...corsHeaders, \'Content-Type\': \'application/json\' },\n' +
  '    });\n' +
  '  } catch (error) {\n' +
  '    return new Response(JSON.stringify({ ok: false, error: String(error) }), {\n' +
  '      status: 200,\n' +
  '      headers: { ...corsHeaders, \'Content-Type\': \'application/json\' },\n' +
  '    });\n' +
  '  }\n' +
  '}\n\n';
content = content.replace(getHtmlAnchor, handlerFn + getHtmlAnchor);
console.log('✓ Backend handler added');

// ── Change 3: Add 'api-tester' to TAB_ROUTES ────────────────────────────────
const tabRoutesAnchor = "'guide': '/guide',\n        };";
if (!content.includes(tabRoutesAnchor)) throw new Error('TAB_ROUTES anchor not found');
content = content.replace(tabRoutesAnchor, "'guide': '/guide',\n            'api-tester': '/api-tester',\n        };");
console.log('✓ TAB_ROUTES updated');

// ── Change 4: Add 'api-tester' to PAGE_TITLES in switchTab ──────────────────
const pageTitlesAnchor = "guide: 'Guide' };";
if (!content.includes(pageTitlesAnchor)) throw new Error('PAGE_TITLES anchor not found');
content = content.replace(pageTitlesAnchor, "guide: 'Guide', 'api-tester': 'API Tester' };");
console.log('✓ PAGE_TITLES updated');

// ── Change 5: Add nav item (before </nav>) ───────────────────────────────────
const navAnchor =
  '                    <span class="text-sm">Guide</span>\n' +
  '                </a>\n' +
  '            </nav>';
if (!content.includes(navAnchor)) throw new Error('Nav anchor not found');
const navItem =
  '                    <span class="text-sm">Guide</span>\n' +
  '                </a>\n' +
  '                <a href="/api-tester" onclick="event.preventDefault();switchTab(\'api-tester\')" data-tab="api-tester" class="sidebar-btn w-full flex items-center gap-3 px-6 py-3 border-l-2 border-transparent text-dark-400 hover:text-dark-100 hover:bg-dark-800/50 transition-all duration-200" title="API Tester">\n' +
  '                    <svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"></path></svg>\n' +
  '                    <span class="text-sm">API Tester</span>\n' +
  '                </a>\n' +
  '            </nav>';
content = content.replace(navAnchor, navItem);
console.log('✓ Nav item added');

// ── Change 6: Add tab content div (before the padding wrapper closes) ────────
const tabAnchor = '            </div>\n\n            </div>\n        </main>';
if (!content.includes(tabAnchor)) throw new Error('Tab anchor not found — div sequence not unique or not present');

const tabDiv =
  '            <div id="tab-api-tester" class="tab-content hidden">\n' +
  '                <div class="flex items-center justify-between mb-6">\n' +
  '                    <h2 class="text-xl font-bold text-white">API Call Tester</h2>\n' +
  '                    <span class="text-sm text-gray-500">All requests route via relay &rarr; zmawsolutions.com</span>\n' +
  '                </div>\n' +
  '                <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">\n' +
  '                    <!-- Request Panel -->\n' +
  '                    <div class="bg-dark-800 rounded-xl border border-dark-600 p-5">\n' +
  '                        <h3 class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">Request</h3>\n' +
  '                        <div class="mb-4">\n' +
  '                            <label class="text-xs text-gray-500 mb-1 block">Preset</label>\n' +
  '                            <select id="api-tester-preset" onchange="applyApiPreset()" class="w-full text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300 focus:outline-none focus:border-accent">\n' +
  '                                <option value="">&#8212; Custom &#8212;</option>\n' +
  '                                <option value="atomic">ATOMIC (AT&amp;T)</option>\n' +
  '                                <option value="wing">Wing IoT (AT&amp;T)</option>\n' +
  '                                <option value="teltik">Teltik (T-Mobile)</option>\n' +
  '                                <option value="helix">Helix (AT&amp;T, legacy)</option>\n' +
  '                            </select>\n' +
  '                        </div>\n' +
  '                        <div class="flex gap-2 mb-4">\n' +
  '                            <select id="api-tester-method" class="text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300 focus:outline-none focus:border-accent w-28">\n' +
  '                                <option>GET</option>\n' +
  '                                <option selected>POST</option>\n' +
  '                                <option>PUT</option>\n' +
  '                                <option>PATCH</option>\n' +
  '                                <option>DELETE</option>\n' +
  '                            </select>\n' +
  '                            <input id="api-tester-url" type="text" placeholder="https://..." class="flex-1 text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300 font-mono focus:outline-none focus:border-accent">\n' +
  '                        </div>\n' +
  '                        <div class="mb-4">\n' +
  '                            <div class="flex items-center justify-between mb-2">\n' +
  '                                <span class="text-xs text-gray-500">Headers</span>\n' +
  '                                <button onclick="addRelayHeader()" class="text-xs text-accent hover:text-green-400 transition">+ Add</button>\n' +
  '                            </div>\n' +
  '                            <div id="api-tester-headers" class="space-y-2"></div>\n' +
  '                        </div>\n' +
  '                        <div class="mb-5">\n' +
  '                            <label class="text-xs text-gray-500 mb-1 block">Body (raw)</label>\n' +
  '                            <textarea id="api-tester-body" rows="8" class="w-full text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300 font-mono focus:outline-none focus:border-accent" placeholder="Raw JSON or text body"></textarea>\n' +
  '                        </div>\n' +
  '                        <button onclick="sendRelayTest()" id="api-tester-send" class="w-full py-2 bg-accent hover:bg-green-600 text-white rounded-lg text-sm font-medium transition">Send via Relay</button>\n' +
  '                    </div>\n' +
  '                    <!-- Response Panel -->\n' +
  '                    <div class="bg-dark-800 rounded-xl border border-dark-600 p-5 flex flex-col">\n' +
  '                        <div class="flex items-center justify-between mb-4">\n' +
  '                            <h3 class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Response</h3>\n' +
  '                            <span id="api-tester-status" class="text-sm font-mono font-bold"></span>\n' +
  '                        </div>\n' +
  '                        <div id="api-tester-response-headers" class="mb-3 hidden">\n' +
  '                            <details class="group">\n' +
  '                                <summary class="text-xs text-gray-500 cursor-pointer hover:text-gray-300 mb-1">Response Headers</summary>\n' +
  '                                <pre id="api-tester-resp-headers-body" class="text-xs text-gray-400 font-mono bg-dark-900 rounded p-2 mt-1 overflow-x-auto border border-dark-600"></pre>\n' +
  '                            </details>\n' +
  '                        </div>\n' +
  '                        <pre id="api-tester-response" class="flex-1 bg-dark-900 rounded-lg p-4 text-xs font-mono text-gray-300 overflow-auto max-h-96 border border-dark-600 whitespace-pre-wrap break-all">Response will appear here...</pre>\n' +
  '                    </div>\n' +
  '                </div>\n' +
  '            </div>\n\n';

content = content.replace(tabAnchor, tabDiv + tabAnchor);
console.log('✓ Tab content div added');

// ── Change 7: Add frontend JS functions (before closing </script>) ────────────
const scriptCloseAnchor =
  '        loadData();\n' +
  '        setInterval(loadData, 3600000);\n' +
  '        initTabFromUrl();\n' +
  '    </script>';
if (!content.includes(scriptCloseAnchor)) throw new Error('Script close anchor not found');

const frontendFns =
  '        // ── API Tester ────────────────────────────────────────────────────────\n' +
  '        var API_TESTER_PRESETS = {\n' +
  '            atomic: { method: \'POST\', url: \'https://solutionsatt-atomic.telgoo5.com/\', headers: [[\'Content-Type\', \'application/json\']], body: \'{"operation":""}\' },\n' +
  '            wing:   { method: \'GET\',  url: \'https://restapi19.att.com/\', headers: [[\'Authorization\', \'Basic \'],[\'Accept\', \'application/json\']], body: \'\' },\n' +
  '            teltik: { method: \'GET\',  url: \'https://api.smsgateway.xyz/lines?apikey=\', headers: [], body: \'\' },\n' +
  '            helix:  { method: \'POST\', url: \'\', headers: [[\'Content-Type\', \'application/json\']], body: \'{}\' },\n' +
  '        };\n\n' +
  '        function addRelayHeader(key, val) {\n' +
  '            key = key || \'\';\n' +
  '            val = val || \'\';\n' +
  '            var container = document.getElementById(\'api-tester-headers\');\n' +
  '            var row = document.createElement(\'div\');\n' +
  '            row.className = \'flex gap-2 items-center\';\n' +
  '            var keyIn = document.createElement(\'input\');\n' +
  '            keyIn.type = \'text\';\n' +
  '            keyIn.placeholder = \'Header name\';\n' +
  '            keyIn.value = key;\n' +
  '            keyIn.className = \'flex-1 text-xs bg-dark-900 border border-dark-500 rounded px-2 py-1 text-gray-300 font-mono focus:outline-none focus:border-accent\';\n' +
  '            var valIn = document.createElement(\'input\');\n' +
  '            valIn.type = \'text\';\n' +
  '            valIn.placeholder = \'Value\';\n' +
  '            valIn.value = val;\n' +
  '            valIn.className = \'flex-1 text-xs bg-dark-900 border border-dark-500 rounded px-2 py-1 text-gray-300 font-mono focus:outline-none focus:border-accent\';\n' +
  '            var btn = document.createElement(\'button\');\n' +
  '            btn.innerHTML = \'&times;\';\n' +
  '            btn.className = \'text-red-400 hover:text-red-300 text-lg leading-none px-1 transition\';\n' +
  '            btn.onclick = function() { row.remove(); };\n' +
  '            row.appendChild(keyIn);\n' +
  '            row.appendChild(valIn);\n' +
  '            row.appendChild(btn);\n' +
  '            container.appendChild(row);\n' +
  '        }\n\n' +
  '        function applyApiPreset() {\n' +
  '            var val = document.getElementById(\'api-tester-preset\').value;\n' +
  '            var p = val ? API_TESTER_PRESETS[val] : null;\n' +
  '            if (!p) return;\n' +
  '            document.getElementById(\'api-tester-method\').value = p.method;\n' +
  '            document.getElementById(\'api-tester-url\').value = p.url;\n' +
  '            document.getElementById(\'api-tester-headers\').innerHTML = \'\';\n' +
  '            (p.headers || []).forEach(function(h) { addRelayHeader(h[0], h[1]); });\n' +
  '            document.getElementById(\'api-tester-body\').value = p.body;\n' +
  '        }\n\n' +
  '        async function sendRelayTest() {\n' +
  '            var method = document.getElementById(\'api-tester-method\').value;\n' +
  '            var url = (document.getElementById(\'api-tester-url\').value || \'\').trim();\n' +
  '            var statusEl = document.getElementById(\'api-tester-status\');\n' +
  '            var responseEl = document.getElementById(\'api-tester-response\');\n' +
  '            var respHeadersEl = document.getElementById(\'api-tester-resp-headers-body\');\n' +
  '            var respHeadersWrap = document.getElementById(\'api-tester-response-headers\');\n' +
  '            var sendBtn = document.getElementById(\'api-tester-send\');\n' +
  '            if (!url) { showToast(\'URL is required\', \'error\'); return; }\n' +
  '            var headers = {};\n' +
  '            document.querySelectorAll(\'#api-tester-headers > div\').forEach(function(row) {\n' +
  '                var inputs = row.querySelectorAll(\'input\');\n' +
  '                var k = inputs[0].value.trim();\n' +
  '                if (k) headers[k] = inputs[1].value;\n' +
  '            });\n' +
  '            var hasBody = [\'POST\', \'PUT\', \'PATCH\'].includes(method);\n' +
  '            var body = hasBody ? (document.getElementById(\'api-tester-body\').value || \'\') : null;\n' +
  '            sendBtn.textContent = \'Sending...\';\n' +
  '            sendBtn.disabled = true;\n' +
  '            statusEl.innerHTML = \'\';\n' +
  '            responseEl.textContent = \'...\';\n' +
  '            respHeadersWrap.classList.add(\'hidden\');\n' +
  '            try {\n' +
  '                var res = await fetch(API_BASE + \'/relay-test\', {\n' +
  '                    method: \'POST\',\n' +
  '                    headers: { \'Content-Type\': \'application/json\' },\n' +
  '                    body: JSON.stringify({ method: method, url: url, headers: headers, body: body })\n' +
  '                });\n' +
  '                var data = await res.json();\n' +
  '                if (!data.ok) {\n' +
  '                    statusEl.innerHTML = \'<span class="text-red-400">Error</span>\';\n' +
  '                    responseEl.textContent = data.error || \'Unknown error\';\n' +
  '                } else {\n' +
  '                    var ok2xx = data.status >= 200 && data.status < 300;\n' +
  '                    statusEl.innerHTML = \'<span class="\' + (ok2xx ? \'text-green-400\' : \'text-red-400\') + \'">\' + data.status + \'</span>\';\n' +
  '                    var bodyText = data.body;\n' +
  '                    try { bodyText = JSON.stringify(JSON.parse(data.body), null, 2); } catch(e) {}\n' +
  '                    responseEl.textContent = bodyText;\n' +
  '                    if (data.headers && Object.keys(data.headers).length) {\n' +
  '                        respHeadersEl.textContent = JSON.stringify(data.headers, null, 2);\n' +
  '                        respHeadersWrap.classList.remove(\'hidden\');\n' +
  '                    }\n' +
  '                }\n' +
  '            } catch (err) {\n' +
  '                statusEl.innerHTML = \'<span class="text-red-400">Error</span>\';\n' +
  '                responseEl.textContent = \'Fetch failed: \' + err;\n' +
  '            } finally {\n' +
  '                sendBtn.textContent = \'Send via Relay\';\n' +
  '                sendBtn.disabled = false;\n' +
  '            }\n' +
  '        }\n\n' +
  '        loadData();\n' +
  '        setInterval(loadData, 3600000);\n' +
  '        initTabFromUrl();\n' +
  '    </script>';

content = content.replace(scriptCloseAnchor, frontendFns);
console.log('✓ Frontend JS functions added');

// ── Write back with CRLF ─────────────────────────────────────────────────────
content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Done. Run: node --input-type=module --check < src/dashboard/index.js');
