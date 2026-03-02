const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src', 'dashboard', 'index.js');
let src = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');

// --- 1. Add /api/imei-pool/pick route in the routing block ---
const OLD_ROUTE = `    if (url.pathname === '/api/imei-pool') {
      if (request.method === 'GET') return handleImeiPoolGet(env, corsHeaders);
      if (request.method === 'POST') return handleImeiPoolPost(request, env, corsHeaders);
    }`;

const NEW_ROUTE = `    if (url.pathname === '/api/imei-pool') {
      if (request.method === 'GET') return handleImeiPoolGet(env, corsHeaders);
      if (request.method === 'POST') return handleImeiPoolPost(request, env, corsHeaders);
    }

    if (url.pathname === '/api/imei-pool/pick' && request.method === 'GET') {
      return handleImeiPoolPick(env, corsHeaders);
    }`;

if (!src.includes(OLD_ROUTE)) { console.error('PATCH 1 not found'); process.exit(1); }
src = src.replace(OLD_ROUTE, NEW_ROUTE);
console.log('Patch 1: added /api/imei-pool/pick route');

// --- 2. Add the backend handler before handleImeiPoolPost ---
const HANDLER_ANCHOR = `async function handleImeiPoolPost(`;
const NEW_HANDLER = `async function handleImeiPoolPick(env, corsHeaders) {
  try {
    const response = await fetch(
      \`\${env.SUPABASE_URL}/rest/v1/imei_pool?select=imei&status=eq.available&limit=1\`,
      {
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: \`Bearer \${env.SUPABASE_SERVICE_ROLE_KEY}\`,
          Accept: 'application/json',
        },
      }
    );
    const rows = await response.json();
    if (!Array.isArray(rows) || rows.length === 0) {
      return new Response(JSON.stringify({ ok: false, error: 'No available IMEIs in pool' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true, imei: rows[0].imei }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ ok: false, error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}

async function handleImeiPoolPost(`;

if (!src.includes(HANDLER_ANCHOR)) { console.error('PATCH 2 anchor not found'); process.exit(1); }
src = src.replace(HANDLER_ANCHOR, NEW_HANDLER);
console.log('Patch 2: added handleImeiPoolPick backend function');

// --- 3. Add "Auto" button next to the IMEI input in the modal HTML ---
const OLD_IMEI_INPUT =
  '                    <label class="block text-sm text-gray-400 mb-2">IMEI (for Set only)</label>\n' +
  '                    <input type="text" id="gw-imei-value" class="w-full px-3 py-2 bg-dark-700 border border-dark-500 rounded-lg text-gray-200 text-sm focus:outline-none focus:border-accent" placeholder="15-digit IMEI"/>';

const NEW_IMEI_INPUT =
  '                    <label class="block text-sm text-gray-400 mb-2">IMEI (for Set only)</label>\n' +
  '                    <div class="flex gap-2">\n' +
  '                        <input type="text" id="gw-imei-value" class="flex-1 px-3 py-2 bg-dark-700 border border-dark-500 rounded-lg text-gray-200 text-sm focus:outline-none focus:border-accent" placeholder="15-digit IMEI"/>\n' +
  '                        <button onclick="gwAutoPickImei()" id="gw-auto-pick-btn" class="px-3 py-2 text-sm bg-dark-600 hover:bg-dark-500 border border-dark-500 text-gray-300 rounded-lg transition whitespace-nowrap">Auto</button>\n' +
  '                    </div>';

if (!src.includes(OLD_IMEI_INPUT)) { console.error('PATCH 3 not found'); process.exit(1); }
src = src.replace(OLD_IMEI_INPUT, NEW_IMEI_INPUT);
console.log('Patch 3: added Auto button in IMEI modal HTML');

// --- 4. Add gwAutoPickImei() JS function before gwSetImei ---
// This code lives inside the getHTML() template literal.
// String concatenation is used (no backticks/\${}) to avoid template escaping issues.
const OLD_SET_IMEI_FN = '        async function gwSetImei() {';
const NEW_AUTO_PICK_FN = [
  '        async function gwAutoPickImei() {',
  "            const btn = document.getElementById('gw-auto-pick-btn');",
  "            btn.disabled = true; btn.textContent = '...';",
  '            try {',
  "                const res = await fetch(API_BASE + '/imei-pool/pick');",
  '                const data = await res.json();',
  '                if (data.ok) {',
  "                    document.getElementById('gw-imei-value').value = data.imei;",
  "                    showToast('IMEI auto-selected: ' + data.imei, 'success');",
  '                } else {',
  "                    showToast(data.error || 'No available IMEIs in pool', 'error');",
  '                }',
  '            } catch (e) {',
  "                showToast('Failed to pick IMEI', 'error');",
  '            } finally {',
  "                btn.disabled = false; btn.textContent = 'Auto';",
  '            }',
  '        }',
  '',
  '        async function gwSetImei() {',
].join('\n');

if (!src.includes(OLD_SET_IMEI_FN)) { console.error('PATCH 4 anchor not found'); process.exit(1); }
src = src.replace(OLD_SET_IMEI_FN, NEW_AUTO_PICK_FN);
console.log('Patch 4: added gwAutoPickImei JS function');

// Write back with CRLF
fs.writeFileSync(filePath, src.replace(/\n/g, '\r\n'), 'utf8');
console.log('Done. File written.');
