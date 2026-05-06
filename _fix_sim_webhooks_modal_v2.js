// _fix_sim_webhooks_modal_v2.js
// Corrective patch: the first pass put `\n` (2 chars) into the file inside a
// browser-side string literal. The outer getHTML() template collapsed those
// to real newlines, breaking the frontend JS. Replace the function body with
// a correctly DOUBLE-escaped version so `\\n` lands in the file → `\n` lands
// in the browser-side source → newline char in the rendered string.

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

const BT = '\\' + '`';    // \`
const DS = '\\' + '${';   // \${
const NL = '\\' + '\\' + 'n';  // \\n — survives the outer template as \n in browser

// Locate current viewSimWebhooks and slice it out
const fnStart = content.indexOf('        async function viewSimWebhooks(simId) {');
if (fnStart === -1) {
  console.error('PATCH FAILED: viewSimWebhooks not found — did v1 patch run?');
  process.exit(1);
}
// End: first "        }\n\n" (12-space-indented closing brace) after fnStart
let i = fnStart + 1;
let depth = 0, seenOpen = false;
while (i < content.length) {
  const c = content[i];
  if (c === '{') { depth++; seenOpen = true; }
  else if (c === '}') { depth--; if (seenOpen && depth === 0) { i++; break; } }
  i++;
}
if (i >= content.length) { console.error('PATCH FAILED: end of viewSimWebhooks not found'); process.exit(1); }
const before = content.slice(0, fnStart);
const after  = content.slice(i);

const fn =
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
  '                        \'[\' + when + \']  \' + st + \'  attempts=\' + (r.attempts || 0) + \'' + NL + '\' +\n' +
  '                        \'  reseller=\' + rid + \'  number=\' + number + \'  iccid=\' + iccid + \'' + NL + '\' +\n' +
  '                        \'  online_until=\' + until + \'' + NL + '\' +\n' +
  '                        \'  delivered_at=\' + delivered + \'' + NL + '\' +\n' +
  '                        \'  url=\' + (r.webhook_url || \'—\') + \'' + NL + '\' +\n' +
  '                        (respSnip ? \'  response=\' + respSnip + \'' + NL + '\' : \'\')\n' +
  '                    );\n' +
  '                }).join(\'' + NL + '\');\n' +
  '                outEl.textContent = \'Showing \' + rows.length + \' most-recent number.online delivery(ies):' + NL + NL + '\' + lines;\n' +
  '            } catch (e) {\n' +
  '                outEl.textContent = \'Error loading webhooks: \' + (e && e.message ? e.message : e);\n' +
  '            }\n' +
  '        }';

content = before + fn + after;

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('v2 patch applied: viewSimWebhooks re-escaped with double-backslash \\n.');
