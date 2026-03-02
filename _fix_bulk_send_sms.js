// Patch: Add Bulk SMS Send to Selected SIMs
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src', 'dashboard', 'index.js');
let src = fs.readFileSync(filePath, 'utf8');

// Normalize to LF
src = src.replace(/\r\n/g, '\n');

// ─── PATCH 1: Route ────────────────────────────────────────────────────────
const routeAnchor = "    if (url.pathname === '/api/send-test-sms') {\n      return handleSendTestSms(request, env, corsHeaders);\n    }";
const routeInsert = routeAnchor + "\n\n    if (url.pathname === '/api/bulk-send-test-sms' && request.method === 'POST') {\n      return handleBulkSendTestSms(request, env, corsHeaders);\n    }";

if (!src.includes(routeAnchor)) { console.error('PATCH 1 anchor not found'); process.exit(1); }
src = src.replace(routeAnchor, routeInsert);
console.log('Patch 1 applied: route');

// ─── PATCH 2: Backend handler ──────────────────────────────────────────────
const handlerAnchor = "async function handleSkylineProxy(request, env, url, corsHeaders) {";

const handlerInsert = `async function handleBulkSendTestSms(request, env, corsHeaders) {
  try {
    const body = await request.json();
    const { target_sim_ids, message } = body;

    if (!Array.isArray(target_sim_ids) || target_sim_ids.length === 0) {
      return new Response(JSON.stringify({ error: 'target_sim_ids must be a non-empty array' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return new Response(JSON.stringify({ error: 'message is required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    if (message.length > 160) {
      return new Response(JSON.stringify({ error: 'message must be 160 chars or fewer' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const sbUrl = env.SUPABASE_URL;
    const sbKey = env.SUPABASE_SERVICE_ROLE_KEY;
    const idList = target_sim_ids.join(',');

    // Fetch target SIMs with their current MDNs
    const targetsRes = await fetch(
      sbUrl + '/rest/v1/sims?select=id,gateway_id,port,sim_numbers(e164)&id=in.(' + idList + ')&sim_numbers.valid_to=is.null',
      { headers: { apikey: sbKey, Authorization: 'Bearer ' + sbKey } }
    );
    if (!targetsRes.ok) {
      const errText = await targetsRes.text();
      return new Response(JSON.stringify({ error: 'DB error fetching targets: ' + errText }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const targets = await targetsRes.json();

    // Fetch sender pool: active SIMs with gateway+port+MDN, not in target list
    const sendersRes = await fetch(
      sbUrl + '/rest/v1/sims?select=id,gateway_id,port,sim_numbers(e164)&status=eq.active&gateway_id=not.is.null&port=not.is.null&sim_numbers.valid_to=is.null&limit=200',
      { headers: { apikey: sbKey, Authorization: 'Bearer ' + sbKey } }
    );
    if (!sendersRes.ok) {
      const errText = await sendersRes.text();
      return new Response(JSON.stringify({ error: 'DB error fetching senders: ' + errText }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const allSenders = await sendersRes.json();

    // Filter out targets from sender pool and senders with no MDN
    const targetSet = new Set(target_sim_ids.map(Number));
    const senders = allSenders.filter(s =>
      !targetSet.has(s.id) &&
      Array.isArray(s.sim_numbers) && s.sim_numbers.length > 0 && s.sim_numbers[0].e164
    );

    if (senders.length === 0) {
      return new Response(JSON.stringify({ ok: false, error: 'No eligible sender SIMs available' }), {
        status: 422, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Fisher-Yates shuffle
    for (let i = senders.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [senders[i], senders[j]] = [senders[j], senders[i]];
    }

    const results = [];
    const skipped = [];
    let sentCount = 0;
    let errorCount = 0;
    let senderIdx = 0;

    for (const target of targets) {
      const targetMdn = Array.isArray(target.sim_numbers) && target.sim_numbers.length > 0
        ? target.sim_numbers[0].e164
        : null;

      if (!targetMdn) {
        skipped.push({ target_sim_id: target.id, reason: 'no_mdn' });
        continue;
      }

      const sender = senders[senderIdx % senders.length];
      senderIdx++;

      try {
        const skylineRes = await env.SKYLINE_GATEWAY.fetch(
          'https://skyline-gateway/send-sms?secret=' + encodeURIComponent(env.SKYLINE_SECRET),
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              gateway_id: sender.gateway_id,
              port: sender.port,
              to: targetMdn,
              message
            })
          }
        );
        const resText = await skylineRes.text();
        let resJson;
        try { resJson = JSON.parse(resText); } catch { resJson = { raw: resText }; }

        if (skylineRes.ok) {
          sentCount++;
          results.push({ target_sim_id: target.id, target_mdn: targetMdn, sender_sim_id: sender.id, sender_port: sender.port, ok: true });
        } else {
          errorCount++;
          const errMsg = resJson.error || resJson.raw || ('HTTP ' + skylineRes.status);
          results.push({ target_sim_id: target.id, target_mdn: targetMdn, sender_sim_id: sender.id, sender_port: sender.port, ok: false, error: errMsg });
        }
      } catch (e) {
        errorCount++;
        results.push({ target_sim_id: target.id, target_mdn: targetMdn, sender_sim_id: sender.id, sender_port: sender.port, ok: false, error: String(e) });
      }
    }

    return new Response(JSON.stringify({ ok: true, sent: sentCount, skipped: skipped.length, errors: errorCount, results, skipped_list: skipped }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

` + handlerAnchor;

if (!src.includes(handlerAnchor)) { console.error('PATCH 2 anchor not found'); process.exit(1); }
src = src.replace(handlerAnchor, handlerInsert);
console.log('Patch 2 applied: handleBulkSendTestSms');

// ─── PATCH 3: Button in sim-action-bar ────────────────────────────────────
const buttonAnchor = '<button onclick="bulkSendOnline()" class="px-3 py-1.5 text-xs bg-indigo-600 hover:bg-indigo-700 text-white rounded transition">Send Online</button>';
const buttonInsert = buttonAnchor + '\n                    <button onclick="showBulkSendSmsModal()" class="px-3 py-1.5 text-xs bg-teal-600 hover:bg-teal-700 text-white rounded transition">Send SMS</button>';

if (!src.includes(buttonAnchor)) { console.error('PATCH 3 anchor not found'); process.exit(1); }
src = src.replace(buttonAnchor, buttonInsert);
console.log('Patch 3 applied: Send SMS button');

// ─── PATCH 4: Modal HTML ───────────────────────────────────────────────────
const modalAnchor = '</body>\n</html>`;';

const modalHtml =
  '        <!-- Bulk Send SMS Modal -->\n' +
  '        <div id="bulk-send-sms-modal" class="fixed inset-0 bg-black/70 z-50 hidden flex items-center justify-center p-4">\n' +
  '            <div class="bg-dark-800 rounded-xl border border-dark-600 w-full max-w-lg">\n' +
  '                <div class="px-5 py-4 border-b border-dark-600 flex items-center justify-between">\n' +
  '                    <h3 class="text-white font-semibold">Send Test SMS</h3>\n' +
  '                    <button onclick="document.getElementById(\'bulk-send-sms-modal\').classList.add(\'hidden\')" class="text-gray-400 hover:text-white text-xl leading-none">&times;</button>\n' +
  '                </div>\n' +
  '                <div class="p-5 space-y-4">\n' +
  '                    <p class="text-sm text-gray-400">Sending to <span id="bulk-sms-count" class="text-white font-semibold">0</span> selected SIM(s).</p>\n' +
  '                    <div>\n' +
  '                        <label class="text-sm text-gray-400 block mb-1">Message <span class="text-xs">(max 160 chars)</span></label>\n' +
  '                        <textarea id="bulk-sms-message" maxlength="160" rows="3" class="w-full text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300 resize-none">Test SMS \xe2\x80\x94 can you receive this message?</textarea>\n' +
  '                    </div>\n' +
  '                    <p class="text-xs text-gray-500">Sender picked randomly from active SIMs, rotated to avoid spam.</p>\n' +
  '                    <div id="bulk-sms-results" class="hidden">\n' +
  '                        <p id="bulk-sms-summary" class="text-sm text-gray-300 mb-2"></p>\n' +
  '                        <div class="overflow-auto max-h-64">\n' +
  '                            <table class="w-full text-xs">\n' +
  '                                <thead>\n' +
  '                                    <tr class="text-gray-400 border-b border-dark-600">\n' +
  '                                        <th class="text-left py-1 pr-3">SIM</th>\n' +
  '                                        <th class="text-left py-1 pr-3">MDN</th>\n' +
  '                                        <th class="text-left py-1 pr-3">Sender Port</th>\n' +
  '                                        <th class="text-left py-1">Status</th>\n' +
  '                                    </tr>\n' +
  '                                </thead>\n' +
  '                                <tbody id="bulk-sms-result-body" class="text-gray-300"></tbody>\n' +
  '                            </table>\n' +
  '                        </div>\n' +
  '                    </div>\n' +
  '                </div>\n' +
  '                <div class="px-5 py-4 border-t border-dark-600 flex justify-end gap-3">\n' +
  '                    <button onclick="document.getElementById(\'bulk-send-sms-modal\').classList.add(\'hidden\')" class="px-4 py-2 text-sm text-gray-400 hover:text-white transition">Close</button>\n' +
  '                    <button id="bulk-sms-send-btn" onclick="runBulkSendSms()" class="px-4 py-2 text-sm bg-teal-600 hover:bg-teal-700 text-white rounded-lg transition">Send</button>\n' +
  '                </div>\n' +
  '            </div>\n' +
  '        </div>\n' +
  '</body>\n' +
  '</html>`;';

if (!src.includes(modalAnchor)) { console.error('PATCH 4 anchor not found'); process.exit(1); }
src = src.replace(modalAnchor, modalHtml);
console.log('Patch 4 applied: modal HTML');

// ─── PATCH 5: JS Functions ─────────────────────────────────────────────────
const jsFnAnchor = "        async function bulkSendOnline() {";

const jsFnInsert =
  "        function showBulkSendSmsModal() {\n" +
  "            const selectedIds = [...document.querySelectorAll('.sim-cb:checked')].map(cb => parseInt(cb.value));\n" +
  "            if (selectedIds.length === 0) {\n" +
  "                alert('Select at least one SIM first');\n" +
  "                return;\n" +
  "            }\n" +
  "            document.getElementById('bulk-sms-count').textContent = selectedIds.length;\n" +
  "            document.getElementById('bulk-sms-results').classList.add('hidden');\n" +
  "            document.getElementById('bulk-sms-result-body').innerHTML = '';\n" +
  "            const sendBtn = document.getElementById('bulk-sms-send-btn');\n" +
  "            sendBtn.disabled = false;\n" +
  "            sendBtn.textContent = 'Send';\n" +
  "            document.getElementById('bulk-send-sms-modal').classList.remove('hidden');\n" +
  "        }\n\n" +
  "        async function runBulkSendSms() {\n" +
  "            const selectedIds = [...document.querySelectorAll('.sim-cb:checked')].map(cb => parseInt(cb.value));\n" +
  "            if (selectedIds.length === 0) { alert('No SIMs selected'); return; }\n" +
  "            const message = document.getElementById('bulk-sms-message').value.trim();\n" +
  "            if (!message) { alert('Please enter a message'); return; }\n" +
  "            const sendBtn = document.getElementById('bulk-sms-send-btn');\n" +
  "            sendBtn.disabled = true;\n" +
  "            sendBtn.textContent = 'Sending...';\n" +
  "            try {\n" +
  "                const resp = await fetch(API_BASE + '/bulk-send-test-sms', {\n" +
  "                    method: 'POST',\n" +
  "                    headers: { 'Content-Type': 'application/json' },\n" +
  "                    body: JSON.stringify({ target_sim_ids: selectedIds, message })\n" +
  "                });\n" +
  "                const data = await resp.json();\n" +
  "                const tbody = document.getElementById('bulk-sms-result-body');\n" +
  "                tbody.innerHTML = '';\n" +
  "                if (data.results) {\n" +
  "                    for (const r of data.results) {\n" +
  "                        const tr = document.createElement('tr');\n" +
  "                        tr.className = 'border-b border-dark-700';\n" +
  "                        tr.innerHTML = '<td class=\"py-1 pr-3\">' + r.target_sim_id + '</td>' +\n" +
  "                            '<td class=\"py-1 pr-3 font-mono\">' + (r.target_mdn || '-') + '</td>' +\n" +
  "                            '<td class=\"py-1 pr-3\">' + (r.sender_port || '-') + '</td>' +\n" +
  "                            '<td class=\"py-1\">' + (r.ok ? '<span class=\"text-green-400\">\\u2713</span>' : '<span class=\"text-red-400\">\\u2717 ' + (r.error || '') + '</span>') + '</td>';\n" +
  "                        tbody.appendChild(tr);\n" +
  "                    }\n" +
  "                }\n" +
  "                if (data.skipped_list) {\n" +
  "                    for (const sk of data.skipped_list) {\n" +
  "                        const tr = document.createElement('tr');\n" +
  "                        tr.className = 'border-b border-dark-700 opacity-50';\n" +
  "                        tr.innerHTML = '<td class=\"py-1 pr-3\">' + sk.target_sim_id + '</td>' +\n" +
  "                            '<td class=\"py-1 pr-3\">-</td>' +\n" +
  "                            '<td class=\"py-1 pr-3\">-</td>' +\n" +
  "                            '<td class=\"py-1 text-gray-400\">skipped: ' + sk.reason + '</td>';\n" +
  "                        tbody.appendChild(tr);\n" +
  "                    }\n" +
  "                }\n" +
  "                if (data.error && !data.results) {\n" +
  "                    document.getElementById('bulk-sms-summary').textContent = 'Error: ' + data.error;\n" +
  "                } else {\n" +
  "                    const parts = [];\n" +
  "                    if (data.sent != null) parts.push(data.sent + ' sent');\n" +
  "                    if (data.skipped) parts.push(data.skipped + ' skipped (no MDN)');\n" +
  "                    if (data.errors) parts.push(data.errors + ' error(s)');\n" +
  "                    document.getElementById('bulk-sms-summary').textContent = parts.join(', ');\n" +
  "                }\n" +
  "                document.getElementById('bulk-sms-results').classList.remove('hidden');\n" +
  "            } catch (e) {\n" +
  "                document.getElementById('bulk-sms-summary').textContent = 'Request failed: ' + e;\n" +
  "                document.getElementById('bulk-sms-results').classList.remove('hidden');\n" +
  "            } finally {\n" +
  "                sendBtn.disabled = false;\n" +
  "                sendBtn.textContent = 'Send';\n" +
  "            }\n" +
  "        }\n\n" +
  "        async function bulkSendOnline() {";

if (!src.includes(jsFnAnchor)) { console.error('PATCH 5 anchor not found'); process.exit(1); }
src = src.replace(jsFnAnchor, jsFnInsert);
console.log('Patch 5 applied: JS functions');

// ─── Write back with CRLF ─────────────────────────────────────────────────
const out = src.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, out, 'utf8');
console.log('Written.');
