// _fix_helix_query_js.js — positional patch for the JS functions block
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

const START_MARKER = '        function showHelixQueryModal() {';
const END_MARKER = '\n        async function showTestSmsModal() {';

const start = content.indexOf(START_MARKER);
const end = content.indexOf(END_MARKER, start);

if (start === -1 || end === -1) {
  console.error('PATCH FAILED: JS function markers not found');
  console.error('start:', start, 'end:', end);
  process.exit(1);
}

// Verify we're targeting the right block
const existing = content.slice(start, end);
if (!existing.includes('function queryHelix()') && !existing.includes('async function queryHelix()')) {
  console.error('PATCH FAILED: queryHelix not in the target block');
  process.exit(1);
}

// Build the replacement using string concatenation to avoid backtick issues
const Q = '`';
const D = '${';

const NEW_JS = '        function showHelixQueryModal() {\n'
  + "            document.getElementById('helix-query-modal').classList.remove('hidden');\n"
  + "            document.getElementById('helix-query-result').classList.add('hidden');\n"
  + "            document.getElementById('helix-bulk-result').classList.add('hidden');\n"
  + "            document.getElementById('helix-subid-input').value = '';\n"
  + "            document.getElementById('helix-subid-input').focus();\n"
  + '        }\n'
  + '\n'
  + '        function queryHelixSubId(subId) {\n'
  + "            document.getElementById('helix-query-modal').classList.remove('hidden');\n"
  + "            document.getElementById('helix-query-result').classList.add('hidden');\n"
  + "            document.getElementById('helix-bulk-result').classList.add('hidden');\n"
  + "            document.getElementById('helix-subid-input').value = subId;\n"
  + '            queryHelix();\n'
  + '        }\n'
  + '\n'
  + '        function hideHelixQueryModal() {\n'
  + "            document.getElementById('helix-query-modal').classList.add('hidden');\n"
  + "            document.getElementById('helix-subid-input').value = '';\n"
  + "            document.getElementById('helix-query-result').classList.add('hidden');\n"
  + "            document.getElementById('helix-bulk-result').classList.add('hidden');\n"
  + '        }\n'
  + '\n'
  + '        async function queryHelix() {\n'
  + "            const subId = document.getElementById('helix-subid-input').value.trim();\n"
  + '            if (!subId) {\n'
  + "                showToast('Please enter a Subscription ID', 'error');\n"
  + '                return;\n'
  + '            }\n'
  + '\n'
  + "            const btn = document.getElementById('helix-query-btn');\n"
  + '            btn.disabled = true;\n'
  + "            btn.textContent = 'Querying...';\n"
  + "            document.getElementById('helix-bulk-result').classList.add('hidden');\n"
  + '\n'
  + '            try {\n'
  + '                const response = await fetch(' + Q + D + 'API_BASE}/helix-query' + Q + ', {\n'
  + "                    method: 'POST',\n"
  + "                    headers: { 'Content-Type': 'application/json' },\n"
  + '                    body: JSON.stringify({ mobility_subscription_id: subId })\n'
  + '                });\n'
  + '\n'
  + '                const result = await response.json();\n'
  + "                const outputEl = document.getElementById('helix-query-output');\n"
  + "                const resultDiv = document.getElementById('helix-query-result');\n"
  + "                const dbBanner = document.getElementById('helix-db-update-banner');\n"
  + "                const dbOutput = document.getElementById('helix-db-update-output');\n"
  + '\n'
  + "                dbBanner.classList.add('hidden');\n"
  + '\n'
  + '                if (response.ok && result.ok) {\n'
  + '                    const data = Array.isArray(result.helix_response) ? result.helix_response[0] : result.helix_response;\n'
  + "                    let formatted = '';\n"
  + '                    if (data) {\n'
  + '                        const isCancelled = data.status === \'CANCELLED\' || data.status === \'CANCELED\';\n'
  + '                        formatted = ' + Q + '<span class="text-blue-400 font-bold">status:</span> <span class="' + D + "data.status === 'ACTIVE' ? 'text-accent' : isCancelled ? 'text-red-400' : 'text-orange-400'} font-bold\">" + D + 'data.status || \'N/A\'}</span>\\n' + Q + ';\n'
  + '                        if (data.statusReason) {\n'
  + '                            formatted += ' + Q + '<span class="text-blue-400 font-bold">statusReason:</span> <span class="text-orange-400 font-bold">' + D + 'data.statusReason}</span>\\n' + Q + ';\n'
  + '                        }\n'
  + '                        if (data.canceledAt || data.cancelledAt) {\n'
  + '                            formatted += ' + Q + '<span class="text-blue-400 font-bold">canceledAt:</span> <span class="text-red-300">' + D + 'data.canceledAt || data.cancelledAt}</span>\\n' + Q + ';\n'
  + '                        }\n'
  + '                        formatted += ' + Q + '\\n<span class="text-gray-500">--- Full Response ---</span>\\n' + Q + ';\n'
  + '                        formatted += JSON.stringify(data, null, 2);\n'
  + '                    } else {\n'
  + '                        formatted = JSON.stringify(result.helix_response, null, 2);\n'
  + '                    }\n'
  + '                    outputEl.innerHTML = formatted;\n'
  + '\n'
  + '                    if (result.db_update) {\n'
  + '                        const u = result.db_update;\n'
  + '                        const dbLines = [];\n'
  + "                        if (!u.found) dbLines.push('SIM not found in DB for this sub ID');\n"
  + '                        else {\n'
  + '                            dbLines.push(' + Q + 'ICCID: ' + D + 'u.iccid}' + Q + ');\n'
  + "                            if (u.status_updated) dbLines.push(" + Q + "Status: " + D + "u.previous_status} \u2192 canceled" + Q + ");\n"
  + "                            else if (u.status_already_canceled) dbLines.push('Status: already canceled in DB');\n"
  + "                            if (u.history_inserted) dbLines.push(" + Q + "Cancel date recorded: " + D + "u.canceled_at}" + Q + ");\n"
  + "                            else if (u.history_exists) dbLines.push(" + Q + "Cancel date already in history: " + D + "u.canceled_at}" + Q + ");\n"
  + "                            else if (u.no_cancel_date) dbLines.push('No canceledAt in Helix response \u2014 history not inserted');\n"
  + "                            if (u.error) dbLines.push(" + Q + "Error: " + D + "u.error}" + Q + ");\n"
  + '                        }\n'
  + "                        dbOutput.textContent = dbLines.join('\\n');\n"
  + "                        dbBanner.classList.remove('hidden');\n"
  + '                    }\n'
  + '\n'
  + "                    resultDiv.classList.remove('hidden');\n"
  + '                } else {\n'
  + '                    outputEl.innerHTML = ' + Q + '<span class="text-red-400">Error:</span> ' + D + 'JSON.stringify(result, null, 2)}' + Q + ';\n'
  + "                    resultDiv.classList.remove('hidden');\n"
  + '                }\n'
  + '            } catch (error) {\n'
  + "                showToast('Error querying Helix', 'error');\n"
  + '                console.error(error);\n'
  + '            } finally {\n'
  + '                btn.disabled = false;\n'
  + "                btn.textContent = 'Query';\n"
  + '            }\n'
  + '        }\n'
  + '\n'
  + '        let _bulkNextOffset = 0;\n'
  + '\n'
  + '        async function queryHelixBulk(offset) {\n'
  + "            const btn = document.getElementById('helix-bulk-btn');\n"
  + "            const nextBtn = document.getElementById('helix-bulk-next-btn');\n"
  + '            btn.disabled = true;\n'
  + "            btn.textContent = 'Running...';\n"
  + '            if (nextBtn) nextBtn.disabled = true;\n'
  + "            document.getElementById('helix-query-result').classList.add('hidden');\n"
  + "            document.getElementById('helix-bulk-result').classList.remove('hidden');\n"
  + "            document.getElementById('helix-bulk-summary').innerHTML = '<div class=\"col-span-4 text-sm text-gray-400 py-2\">Querying Helix\u2026 this may take up to 30 seconds.</div>';\n"
  + "            document.getElementById('helix-bulk-changed').classList.add('hidden');\n"
  + "            document.getElementById('helix-bulk-more').classList.add('hidden');\n"
  + '\n'
  + '            try {\n'
  + '                const response = await fetch(' + Q + D + 'API_BASE}/helix-query-bulk' + Q + ', {\n'
  + "                    method: 'POST',\n"
  + "                    headers: { 'Content-Type': 'application/json' },\n"
  + '                    body: JSON.stringify({ limit: 100, offset: offset || 0 })\n'
  + '                });\n'
  + '                const result = await response.json();\n'
  + '\n'
  + '                if (!response.ok || result.error) {\n'
  + "                    document.getElementById('helix-bulk-summary').innerHTML =\n"
  + '                        ' + Q + '<div class="col-span-4 text-sm text-red-400">Error: ' + D + "result.error || 'Unknown error'}</div>" + Q + ';\n'
  + '                    return;\n'
  + '                }\n'
  + '\n'
  + '                _bulkNextOffset = result.next_offset || 0;\n'
  + '\n'
  + '                const stats = [\n'
  + "                    { label: 'Queried', value: result.processed, color: 'text-white' },\n"
  + "                    { label: 'Cancelled Found', value: result.cancelled_found, color: result.cancelled_found > 0 ? 'text-red-400' : 'text-gray-400' },\n"
  + "                    { label: 'DB Updated', value: result.db_updated, color: result.db_updated > 0 ? 'text-yellow-400' : 'text-gray-400' },\n"
  + "                    { label: 'Errors', value: result.errors, color: result.errors > 0 ? 'text-orange-400' : 'text-gray-400' },\n"
  + '                ];\n'
  + "                document.getElementById('helix-bulk-summary').innerHTML = stats.map(s =>\n"
  + '                    ' + Q + '<div class="bg-dark-900 rounded-lg p-3 text-center border border-dark-600"><div class="text-xl font-bold ' + D + "s.color}\">" + D + 's.value}</div><div class="text-xs text-gray-500 mt-1">' + D + 's.label}</div></div>' + Q + '\n'
  + "                ).join('');\n"
  + '\n'
  + '                if (result.changed && result.changed.length > 0) {\n'
  + "                    document.getElementById('helix-bulk-changed-output').textContent = JSON.stringify(result.changed, null, 2);\n"
  + "                    document.getElementById('helix-bulk-changed').classList.remove('hidden');\n"
  + '                }\n'
  + '\n'
  + '                if (result.has_more) {\n'
  + "                    const moreEl = document.getElementById('helix-bulk-more');\n"
  + "                    moreEl.classList.remove('hidden');\n"
  + '                    moreEl.querySelector(\'button\').textContent =\n'
  + '                        ' + Q + 'Run Next Batch (' + D + "result.next_offset}\u2013" + D + 'Math.min(result.next_offset + 100, result.total_eligible)} of ' + D + 'result.total_eligible})' + Q + ';\n'
  + '                }\n'
  + '\n'
  + '                if (result.cancelled_found > 0) {\n'
  + '                    showToast(' + Q + D + "result.cancelled_found} cancelled line" + D + "result.cancelled_found > 1 ? 's' : ''} found \u2014 " + D + 'result.db_updated} DB updated' + Q + ", 'warning');\n"
  + '                } else {\n'
  + '                    showToast(' + Q + 'Bulk query done \u2014 ' + D + 'result.processed} SIMs checked, none cancelled' + Q + ", 'success');\n"
  + '                }\n'
  + '\n'
  + '            } catch (error) {\n'
  + "                document.getElementById('helix-bulk-summary').innerHTML =\n"
  + '                    ' + Q + '<div class="col-span-4 text-sm text-red-400">Error: ' + D + 'error.message}</div>' + Q + ';\n'
  + '                console.error(error);\n'
  + '            } finally {\n'
  + '                btn.disabled = false;\n'
  + "                btn.textContent = 'Bulk Query All SIMs';\n"
  + '                if (nextBtn) nextBtn.disabled = false;\n'
  + '            }\n'
  + '        }\n'
  + '\n'
  + '        function queryHelixBulkNext() {\n'
  + '            queryHelixBulk(_bulkNextOffset);\n'
  + '        }';

content = content.slice(0, start) + NEW_JS + content.slice(end);

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('✓ JS functions patched successfully');
