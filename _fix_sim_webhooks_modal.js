// _fix_sim_webhooks_modal.js
// Adds:
// 1. GET /api/sim-webhooks?sim_id=X — returns recent number.online deliveries
// 2. handleSimWebhooks(env, corsHeaders, url) backend handler
// 3. Makes the "Last Notified" <td> on the SIMs page clickable
// 4. Frontend viewSimWebhooks(simId) that loads results into sim-action-modal

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n'); // normalise to LF for search/replace

const BT = '\\' + '`';    // produces \`   (escaped backtick for inside getHTML)
const DS = '\\' + '${';   // produces \${  (escaped template-expression start)

// ────────────────────────────────────────────────────────────
// Change 1: backend route dispatch — insert after /api/sim-action route
// ────────────────────────────────────────────────────────────
const ROUTE_OLD = `    if (url.pathname === '/api/sim-action' && request.method === 'POST') {
      return handleSimAction(request, env, corsHeaders);
    }`;
const ROUTE_NEW = ROUTE_OLD + `

    if (url.pathname === '/api/sim-webhooks') {
      return handleSimWebhooks(env, corsHeaders, url);
    }`;

if (!content.includes(ROUTE_OLD)) {
  console.error('PATCH FAILED (change 1): sim-action route block not found.');
  process.exit(1);
}
if (content.includes(`'/api/sim-webhooks'`)) {
  console.warn('Change 1 skipped — /api/sim-webhooks route already present.');
} else {
  content = content.replace(ROUTE_OLD, ROUTE_NEW);
}

// ────────────────────────────────────────────────────────────
// Change 2: backend handler — inserted right after handleErrors()
// ────────────────────────────────────────────────────────────
// handleErrors is a top-level async function; find its closing brace by
// looking for the start of the next sibling function.
const HANDLER_INSERT_AFTER = 'async function handleQboMappingsGet';
const HANDLER_POS = content.indexOf(HANDLER_INSERT_AFTER);
if (HANDLER_POS === -1) {
  console.error('PATCH FAILED (change 2): insertion anchor not found.');
  process.exit(1);
}

if (content.includes('async function handleSimWebhooks')) {
  console.warn('Change 2 skipped — handleSimWebhooks already defined.');
} else {
  const handler = [
    'async function handleSimWebhooks(env, corsHeaders, url) {',
    '  try {',
    '    const simId = parseInt(url.searchParams.get(\'sim_id\') || \'0\', 10);',
    '    if (!simId) {',
    '      return new Response(JSON.stringify({ error: \'sim_id required\' }), {',
    '        status: 400, headers: { ...corsHeaders, \'Content-Type\': \'application/json\' }',
    '      });',
    '    }',
    '    // webhook_deliveries.payload is jsonb shaped like { data: { sim_id, iccid, number, ... } }',
    '    // PostgREST supports nested JSON path filtering: payload->data->>sim_id=eq.<id>',
    '    const q = `webhook_deliveries?select=id,event_type,reseller_id,webhook_url,payload,status,attempts,last_attempt_at,delivered_at,created_at,response_body&event_type=eq.number.online&payload->data->>sim_id=eq.${simId}&order=created_at.desc&limit=50`;',
    '    const res = await supabaseGet(env, q);',
    '    const rows = await res.json().catch(() => []);',
    '    const deliveries = Array.isArray(rows) ? rows : [];',
    '    return new Response(JSON.stringify({ ok: true, sim_id: simId, count: deliveries.length, deliveries }), {',
    '      headers: { ...corsHeaders, \'Content-Type\': \'application/json\' }',
    '    });',
    '  } catch (e) {',
    '    return new Response(JSON.stringify({ error: String(e) }), {',
    '      status: 500, headers: { ...corsHeaders, \'Content-Type\': \'application/json\' }',
    '    });',
    '  }',
    '}',
    '',
    '',
  ].join('\n');
  content = content.slice(0, HANDLER_POS) + handler + content.slice(HANDLER_POS);
}

// ────────────────────────────────────────────────────────────
// Change 3: Last Notified <td> → clickable button when a date exists
// ────────────────────────────────────────────────────────────
const TD_OLD =
  '<td class="px-4 py-3 text-gray-500 text-xs">'
  + DS + 'sim.last_notified_at ? new Date(sim.last_notified_at).toLocaleString() : \'-\'}</td>';

const TD_NEW =
  '<td class="px-4 py-3 text-gray-500 text-xs">'
  + DS + 'sim.last_notified_at ? '
  + BT + '<button onclick="viewSimWebhooks(' + DS + 'sim.id})" class="text-indigo-400 hover:text-indigo-300 hover:underline" title="Show number.online deliveries sent for this SIM">'
  + DS + 'new Date(sim.last_notified_at).toLocaleString()}</button>'
  + BT + ' : \'-\'}</td>';

if (!content.includes(TD_OLD)) {
  if (content.includes('viewSimWebhooks(')) {
    console.warn('Change 3 skipped — viewSimWebhooks cell already in place.');
  } else {
    console.error('PATCH FAILED (change 3): Last Notified <td> not found.');
    process.exit(1);
  }
} else {
  content = content.replace(TD_OLD, TD_NEW);
}

// ────────────────────────────────────────────────────────────
// Change 4: Frontend viewSimWebhooks() — inserted right after hideSimActionModal
// ────────────────────────────────────────────────────────────
const FN_ANCHOR = `        function hideSimActionModal() {
            document.getElementById('sim-action-modal').classList.add('hidden');
            document.getElementById('sim-action-output').classList.remove('hidden');
        }`;

if (!content.includes(FN_ANCHOR)) {
  console.error('PATCH FAILED (change 4): hideSimActionModal anchor not found.');
  process.exit(1);
}

if (content.includes('function viewSimWebhooks(')) {
  console.warn('Change 4 skipped — viewSimWebhooks already defined.');
} else {
  // Build with string concat because the body contains backticks and ${…}
  // that must remain escaped inside the outer getHTML template.
  const FN_NEW = FN_ANCHOR + '\n\n' +
    '        async function viewSimWebhooks(simId) {\n' +
    '            const titleEl = document.getElementById(\'sim-action-title\');\n' +
    '            const outEl   = document.getElementById(\'sim-action-output\');\n' +
    '            const logsSec = document.getElementById(\'sim-action-logs-section\');\n' +
    '            const modal   = document.getElementById(\'sim-action-modal\');\n' +
    '            if (logsSec) logsSec.classList.add(\'hidden\');\n' +
    '            titleEl.textContent = \'number.online webhooks — SIM #\' + simId;\n' +
    '            outEl.textContent = \'Loading...\';\n' +
    '            modal.classList.remove(\'hidden\');\n' +
    '            try {\n' +
    '                const res = await fetch(' + BT + DS + 'API_BASE}/api/sim-webhooks?sim_id=' + DS + 'simId}' + BT + ');\n' +
    '                const data = await res.json();\n' +
    '                if (!res.ok) throw new Error(data.error || (\'HTTP \' + res.status));\n' +
    '                const rows = Array.isArray(data.deliveries) ? data.deliveries : [];\n' +
    '                if (rows.length === 0) {\n' +
    '                    outEl.textContent = \'No number.online deliveries logged for SIM #\' + simId + \'.\';\n' +
    '                    return;\n' +
    '                }\n' +
    '                const lines = rows.map(function(r) {\n' +
    '                    const when   = r.created_at ? new Date(r.created_at).toLocaleString() : \'—\';\n' +
    '                    const number = (r.payload && r.payload.data && r.payload.data.number) || \'—\';\n' +
    '                    const iccid  = (r.payload && r.payload.data && r.payload.data.iccid)  || \'—\';\n' +
    '                    const until  = (r.payload && r.payload.data && r.payload.data.online_until) || \'—\';\n' +
    '                    const st     = String(r.status || \'unknown\').toUpperCase();\n' +
    '                    const rid    = r.reseller_id == null ? \'—\' : r.reseller_id;\n' +
    '                    const delivered = r.delivered_at ? new Date(r.delivered_at).toLocaleString() : \'—\';\n' +
    '                    const respSnip  = r.response_body ? String(r.response_body).slice(0, 120) : \'\';\n' +
    '                    return (\n' +
    '                        \'[\' + when + \']  \' + st + \'  attempts=\' + (r.attempts || 0) + \'\\n\' +\n' +
    '                        \'  reseller=\' + rid + \'  number=\' + number + \'  iccid=\' + iccid + \'\\n\' +\n' +
    '                        \'  online_until=\' + until + \'\\n\' +\n' +
    '                        \'  delivered_at=\' + delivered + \'\\n\' +\n' +
    '                        \'  url=\' + (r.webhook_url || \'—\') + \'\\n\' +\n' +
    '                        (respSnip ? \'  response=\' + respSnip + \'\\n\' : \'\')\n' +
    '                    );\n' +
    '                }).join(\'\\n\');\n' +
    '                outEl.textContent = \'Showing \' + rows.length + \' most-recent number.online delivery(ies):\\n\\n\' + lines;\n' +
    '            } catch (e) {\n' +
    '                outEl.textContent = \'Error loading webhooks: \' + (e && e.message ? e.message : e);\n' +
    '            }\n' +
    '        }';

  content = content.replace(FN_ANCHOR, FN_NEW);
}

// ────────────────────────────────────────────────────────────
// Write back with CRLF
// ────────────────────────────────────────────────────────────
content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch applied: /api/sim-webhooks + viewSimWebhooks clickable Last Notified cell.');
