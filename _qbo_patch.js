#!/usr/bin/env node
// Adds QuickBooks Online billing tab to the dashboard
// Run AFTER _rebuild_all.js and _fix_escaping.js
// Usage: node _qbo_patch.js

const fs = require('fs');
const path = require('path');
const filePath = path.join(__dirname, 'src', 'dashboard', 'index.js');

let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');
let lines = content.split('\n');

let changeCount = 0;
function findLine(needle, startFrom = 0) {
  for (let i = startFrom; i < lines.length; i++) {
    if (lines[i].includes(needle)) return i + 1;
  }
  return -1;
}
function insertAfterLine(lineNum, newLines) {
  lines.splice(lineNum, 0, ...newLines);
  changeCount++;
  return newLines.length;
}
function insertBeforeLine(lineNum, newLines) {
  lines.splice(lineNum - 1, 0, ...newLines);
  changeCount++;
  return newLines.length;
}

// ============================================================
// 1. Add /api/qbo/* route handler (server-side, before getHTML)
// ============================================================
let simActionRoute = findLine("url.pathname === '/api/sim-action'");
if (simActionRoute === -1) throw new Error('Cannot find sim-action route');
// Find closing } of this if block
let routeEnd = simActionRoute;
while (routeEnd < lines.length && !lines[routeEnd - 1].match(/^\s{4}\}$/)) routeEnd++;

insertAfterLine(routeEnd, [
  '',
  "    if (url.pathname.startsWith('/api/qbo/')) {",
  '      return handleQboRoute(request, env, corsHeaders, url);',
  '    }',
]);
console.log('[QBO-1] Added /api/qbo/* route');

// ============================================================
// 2. Add handleQboRoute function (before getHTML)
// ============================================================
let getHTMLLine = findLine('function getHTML()');
if (getHTMLLine === -1) throw new Error('Cannot find getHTML function');

insertBeforeLine(getHTMLLine, [
  'async function handleQboRoute(request, env, corsHeaders, url) {',
  '  try {',
  "    if (!env.QUICKBOOKS) return new Response(JSON.stringify({ error: 'QUICKBOOKS binding not configured' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });",
  '',
  "    const qboPath = url.pathname.replace('/api/qbo', '');",
  '    const qboUrl = new URL(`https://quickbooks${qboPath}${url.search}`);',
  '',
  '    const workerResponse = await env.QUICKBOOKS.fetch(qboUrl.toString(), {',
  '      method: request.method,',
  "      headers: request.headers,",
  "      body: request.method !== 'GET' ? await request.text() : undefined,",
  '    });',
  '',
  '    const responseText = await workerResponse.text();',
  '    return new Response(responseText, {',
  '      status: workerResponse.status,',
  "      headers: { ...corsHeaders, 'Content-Type': 'application/json' }",
  '    });',
  '  } catch (error) {',
  '    return new Response(JSON.stringify({ error: String(error) }), {',
  '      status: 500,',
  "      headers: { ...corsHeaders, 'Content-Type': 'application/json' }",
  '    });',
  '  }',
  '}',
  '',
]);
console.log('[QBO-2] Added handleQboRoute function');

// ============================================================
// 3. Add Billing sidebar button (after errors button)
// ============================================================
let errorsBtnLine = findLine('title="Errors"');
if (errorsBtnLine === -1) throw new Error('Cannot find Errors sidebar button');
let errorsBtnEnd = errorsBtnLine;
while (errorsBtnEnd < lines.length && !lines[errorsBtnEnd - 1].includes('</button>')) errorsBtnEnd++;

insertAfterLine(errorsBtnEnd, [
  "                <button onclick=\"switchTab('billing')\" class=\"sidebar-btn w-10 h-10 rounded-lg flex items-center justify-center text-gray-400 hover:text-white hover:bg-dark-600 transition\" title=\"Billing\">",
  '                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>',
  '                </button>',
]);
console.log('[QBO-3] Added Billing sidebar button');

// ============================================================
// 4. Add Billing tab HTML (before </main>)
// ============================================================
let mainCloseLine = findLine('</main>');
if (mainCloseLine === -1) throw new Error('Cannot find </main>');

insertBeforeLine(mainCloseLine, [
  '',
  '            <!-- Billing Tab -->',
  '            <div id="tab-billing" class="tab-content hidden">',
  '                <div class="flex items-center justify-between mb-6">',
  '                    <h2 class="text-xl font-bold text-white">Billing & Invoicing</h2>',
  '                </div>',
  '',
  '                <!-- QBO Connection -->',
  '                <div class="bg-dark-800 rounded-xl p-5 border border-dark-600 mb-6">',
  '                    <h3 class="text-lg font-semibold text-white mb-3">QuickBooks Connection</h3>',
  '                    <div id="qbo-status" class="text-gray-400">Checking connection...</div>',
  '                    <div class="mt-3" id="qbo-actions"></div>',
  '                </div>',
  '',
  '                <!-- Customer Mapping -->',
  '                <div class="bg-dark-800 rounded-xl p-5 border border-dark-600 mb-6">',
  '                    <div class="flex items-center justify-between mb-3">',
  '                        <h3 class="text-lg font-semibold text-white">Customer Mapping</h3>',
  '                        <button onclick="showAddMappingModal()" class="px-3 py-1.5 text-sm bg-accent hover:bg-green-600 text-white rounded-lg transition">+ Add Mapping</button>',
  '                    </div>',
  '                    <div class="overflow-x-auto">',
  '                        <table class="w-full">',
  '                            <thead>',
  '                                <tr class="text-left text-xs text-gray-500 uppercase border-b border-dark-600">',
  '                                    <th class="px-4 py-3 font-medium">Reseller</th>',
  '                                    <th class="px-4 py-3 font-medium">QBO Customer</th>',
  '                                    <th class="px-4 py-3 font-medium">Daily Rate</th>',
  '                                    <th class="px-4 py-3 font-medium">Active SIMs</th>',
  '                                    <th class="px-4 py-3 font-medium">Actions</th>',
  '                                </tr>',
  '                            </thead>',
  '                            <tbody id="mapping-table" class="text-sm">',
  '                                <tr><td colspan="5" class="px-4 py-4 text-center text-gray-500">Loading...</td></tr>',
  '                            </tbody>',
  '                        </table>',
  '                    </div>',
  '                </div>',
  '',
  '                <!-- Invoice Generator -->',
  '                <div class="bg-dark-800 rounded-xl p-5 border border-dark-600 mb-6">',
  '                    <h3 class="text-lg font-semibold text-white mb-3">Generate Invoices</h3>',
  '                    <div class="flex items-center gap-3 mb-4">',
  '                        <label class="text-sm text-gray-400">Week Start:</label>',
  '                        <input type="date" id="invoice-week-start" class="text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300">',
  '                        <button onclick="previewInvoices()" class="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition">Preview</button>',
  '                        <button onclick="createInvoices()" id="create-invoices-btn" class="hidden px-4 py-2 text-sm bg-accent hover:bg-green-600 text-white rounded-lg transition">Create in QBO</button>',
  '                    </div>',
  '                    <div id="invoice-preview" class="text-gray-400 text-sm"></div>',
  '                </div>',
  '',
  '                <!-- Invoice History -->',
  '                <div class="bg-dark-800 rounded-xl p-5 border border-dark-600">',
  '                    <h3 class="text-lg font-semibold text-white mb-3">Invoice History</h3>',
  '                    <div class="overflow-x-auto">',
  '                        <table class="w-full">',
  '                            <thead>',
  '                                <tr class="text-left text-xs text-gray-500 uppercase border-b border-dark-600">',
  '                                    <th class="px-4 py-3 font-medium">Customer</th>',
  '                                    <th class="px-4 py-3 font-medium">Week</th>',
  '                                    <th class="px-4 py-3 font-medium">SIMs</th>',
  '                                    <th class="px-4 py-3 font-medium">Total</th>',
  '                                    <th class="px-4 py-3 font-medium">Status</th>',
  '                                </tr>',
  '                            </thead>',
  '                            <tbody id="invoice-history-table" class="text-sm">',
  '                                <tr><td colspan="5" class="px-4 py-4 text-center text-gray-500">Loading...</td></tr>',
  '                            </tbody>',
  '                        </table>',
  '                    </div>',
  '                </div>',
  '            </div>',
  '',
]);
console.log('[QBO-4] Added Billing tab HTML');

// ============================================================
// 5. Add billing mapping modal HTML (before </body>)
// ============================================================
let bodyCloseLine = findLine('</body>');
if (bodyCloseLine === -1) throw new Error('Cannot find </body>');

insertBeforeLine(bodyCloseLine, [
  '        <!-- Add Mapping Modal -->',
  '        <div id="add-mapping-modal" class="hidden fixed inset-0 bg-black/50 flex items-center justify-center z-50">',
  '            <div class="bg-dark-800 rounded-xl border border-dark-600 p-6 w-full max-w-md">',
  '                <h3 class="text-lg font-semibold text-white mb-4">Add Customer Mapping</h3>',
  '                <div class="space-y-3">',
  '                    <div>',
  '                        <label class="text-sm text-gray-400 block mb-1">Reseller</label>',
  '                        <select id="mapping-reseller" class="w-full text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300"></select>',
  '                    </div>',
  '                    <div>',
  '                        <label class="text-sm text-gray-400 block mb-1">QBO Customer (search)</label>',
  '                        <input type="text" id="mapping-qbo-search" placeholder="Type to search QBO customers..." oninput="searchQboCustomers()" class="w-full text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300">',
  '                        <div id="qbo-search-results" class="mt-1 bg-dark-700 rounded-lg border border-dark-500 max-h-32 overflow-y-auto hidden"></div>',
  '                    </div>',
  '                    <div>',
  '                        <label class="text-sm text-gray-400 block mb-1">Daily Rate ($/SIM/day)</label>',
  '                        <input type="number" id="mapping-rate" step="0.01" value="0.50" class="w-full text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300">',
  '                    </div>',
  '                </div>',
  '                <div class="flex justify-end gap-3 mt-5">',
  '                    <button onclick="closeMappingModal()" class="px-4 py-2 text-sm text-gray-400 hover:text-white transition">Cancel</button>',
  '                    <button onclick="saveMapping()" class="px-4 py-2 text-sm bg-accent hover:bg-green-600 text-white rounded-lg transition">Save</button>',
  '                </div>',
  '            </div>',
  '        </div>',
]);
console.log('[QBO-5] Added mapping modal HTML');

// ============================================================
// 6. JS: Add billing to TAB_ROUTES
// ============================================================
let errorsRouteEntry = findLine("'errors': '/errors',");
if (errorsRouteEntry === -1) throw new Error('Cannot find errors TAB_ROUTE');
insertAfterLine(errorsRouteEntry, [
  "            'billing': '/billing',",
]);
console.log('[QBO-6] Added billing to TAB_ROUTES');

// ============================================================
// 7. JS: Add billing handler to switchTab
// ============================================================
let errorsTabHandler = findLine("if (tabName === 'errors') loadErrors();");
if (errorsTabHandler === -1) throw new Error('Cannot find errors switchTab handler');
insertAfterLine(errorsTabHandler, [
  "            if (tabName === 'billing') loadBillingStatus();",
]);
console.log('[QBO-7] Added billing to switchTab');

// ============================================================
// 8. JS: Add billing functions (before loadGatewayDropdown call)
// ============================================================
let loadGwDropdownLine = findLine('loadGatewayDropdown();');
if (loadGwDropdownLine === -1) throw new Error('Cannot find loadGatewayDropdown call');

insertBeforeLine(loadGwDropdownLine, [
  '',
  '        // ===== Billing (QBO) =====',
  '        let selectedQboCustomer = null;',
  '        let invoicePreviewData = null;',
  '',
  '        async function loadBillingStatus() {',
  '            try {',
  '                const resp = await fetch(`${API_BASE}/qbo/status`);',
  '                const data = await resp.json();',
  '                const statusEl = document.getElementById("qbo-status");',
  '                const actionsEl = document.getElementById("qbo-actions");',
  '                if (data.connected) {',
  '                    statusEl.innerHTML = `<span class="text-accent font-semibold">Connected</span> <span class="text-gray-500 text-sm">(Company: ${data.company_name || data.realm_id || "unknown"})</span>`;',
  '                    actionsEl.innerHTML = `<button onclick="disconnectQbo()" class="px-3 py-1.5 text-xs bg-red-600 hover:bg-red-700 text-white rounded transition">Disconnect</button>`;',
  '                    loadMappings();',
  '                    loadInvoiceHistory();',
  '                } else {',
  '                    statusEl.innerHTML = `<span class="text-yellow-400">Not connected</span>`;',
  '                    actionsEl.innerHTML = `<button onclick="connectQbo()" class="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition">Connect to QuickBooks</button>`;',
  '                }',
  '            } catch (error) {',
  '                document.getElementById("qbo-status").innerHTML = `<span class="text-red-400">Error: ${error}</span>`;',
  '            }',
  '        }',
  '',
  '        async function connectQbo() {',
  '            try {',
  '                const resp = await fetch(`${API_BASE}/qbo/auth-url`);',
  '                const data = await resp.json();',
  '                if (data.url) window.open(data.url, "_blank");',
  '                else showToast("Error getting auth URL: " + JSON.stringify(data), "error");',
  '            } catch (error) {',
  '                showToast("Error: " + error, "error");',
  '            }',
  '        }',
  '',
  '        async function disconnectQbo() {',
  '            if (!confirm("Disconnect from QuickBooks?")) return;',
  '            try {',
  '                await fetch(`${API_BASE}/qbo/disconnect`, { method: "POST" });',
  '                showToast("Disconnected from QuickBooks", "success");',
  '                loadBillingStatus();',
  '            } catch (error) {',
  '                showToast("Error: " + error, "error");',
  '            }',
  '        }',
  '',
  '        async function loadMappings() {',
  '            try {',
  '                const resp = await fetch(`${API_BASE}/qbo-mappings`);',
  '                if (!resp.ok) { document.getElementById("mapping-table").innerHTML = "<tr><td colspan=5 class=\\"px-4 py-4 text-center text-gray-500\\">No mappings yet</td></tr>"; return; }',
  '                const mappings = await resp.json();',
  '                const tbody = document.getElementById("mapping-table");',
  '                if (!mappings.length) { tbody.innerHTML = "<tr><td colspan=5 class=\\"px-4 py-4 text-center text-gray-500\\">No mappings yet</td></tr>"; return; }',
  '                tbody.innerHTML = mappings.map(m => `',
  '                    <tr class="border-b border-dark-600">',
  '                        <td class="px-4 py-3 text-gray-300">${m.reseller_name || m.customer_name || "-"}</td>',
  '                        <td class="px-4 py-3 text-gray-300">${m.qbo_display_name}</td>',
  '                        <td class="px-4 py-3 text-gray-300">$${Number(m.daily_rate).toFixed(2)}</td>',
  '                        <td class="px-4 py-3 text-gray-300">${m.sim_count || "-"}</td>',
  '                        <td class="px-4 py-3"><button onclick="deleteMapping(${m.id})" class="text-xs text-red-400 hover:text-red-300">Delete</button></td>',
  '                    </tr>',
  '                `).join("");',
  '            } catch (error) {',
  '                console.error("Error loading mappings:", error);',
  '            }',
  '        }',
  '',
  '        function showAddMappingModal() {',
  '            selectedQboCustomer = null;',
  '            document.getElementById("mapping-qbo-search").value = "";',
  '            document.getElementById("qbo-search-results").classList.add("hidden");',
  '            document.getElementById("mapping-rate").value = "0.50";',
  '            // Populate reseller dropdown',
  '            const sel = document.getElementById("mapping-reseller");',
  '            sel.innerHTML = "<option value=\\"\\">-- Select Reseller --</option>";',
  '            // Load resellers from existing data',
  '            fetch(`${API_BASE}/resellers`).then(r => r.json()).then(resellers => {',
  '                resellers.forEach(r => {',
  '                    const opt = document.createElement("option");',
  '                    opt.value = r.id; opt.textContent = r.name;',
  '                    sel.appendChild(opt);',
  '                });',
  '            });',
  '            document.getElementById("add-mapping-modal").classList.remove("hidden");',
  '        }',
  '',
  '        function closeMappingModal() {',
  '            document.getElementById("add-mapping-modal").classList.add("hidden");',
  '        }',
  '',
  '        let qboSearchTimeout = null;',
  '        async function searchQboCustomers() {',
  '            clearTimeout(qboSearchTimeout);',
  '            const q = document.getElementById("mapping-qbo-search").value.trim();',
  '            if (q.length < 2) { document.getElementById("qbo-search-results").classList.add("hidden"); return; }',
  '            qboSearchTimeout = setTimeout(async () => {',
  '                try {',
  '                    const resp = await fetch(`${API_BASE}/qbo/customers/search?q=${encodeURIComponent(q)}`);',
  '                    const data = await resp.json();',
  '                    const container = document.getElementById("qbo-search-results");',
  '                    if (data.customers && data.customers.length > 0) {',
  '                        container.innerHTML = data.customers.map(c => `',
  '                            <div class="px-3 py-2 text-sm text-gray-300 hover:bg-dark-600 cursor-pointer" onclick="selectQboCustomer(${c.Id}, \'${(c.DisplayName || "").replace(/\'/g, "\\\\\'")}\')">',
  '                                ${c.DisplayName}',
  '                            </div>',
  '                        `).join("");',
  '                        container.classList.remove("hidden");',
  '                    } else {',
  '                        container.innerHTML = "<div class=\\"px-3 py-2 text-sm text-gray-500\\">No customers found</div>";',
  '                        container.classList.remove("hidden");',
  '                    }',
  '                } catch (error) {',
  '                    console.error("QBO search error:", error);',
  '                }',
  '            }, 300);',
  '        }',
  '',
  '        function selectQboCustomer(id, name) {',
  '            selectedQboCustomer = { id: String(id), name };',
  '            document.getElementById("mapping-qbo-search").value = name;',
  '            document.getElementById("qbo-search-results").classList.add("hidden");',
  '        }',
  '',
  '        async function saveMapping() {',
  '            const resellerId = document.getElementById("mapping-reseller").value;',
  '            const rate = document.getElementById("mapping-rate").value;',
  '            if (!selectedQboCustomer) { showToast("Select a QBO customer first", "error"); return; }',
  '            try {',
  '                const body = {',
  '                    reseller_id: resellerId ? parseInt(resellerId) : null,',
  '                    qbo_customer_id: selectedQboCustomer.id,',
  '                    qbo_display_name: selectedQboCustomer.name,',
  '                    daily_rate: parseFloat(rate)',
  '                };',
  '                const resp = await fetch(`${API_BASE}/qbo-mappings`, {',
  '                    method: "POST",',
  '                    headers: { "Content-Type": "application/json" },',
  '                    body: JSON.stringify(body)',
  '                });',
  '                if (resp.ok) {',
  '                    showToast("Mapping saved", "success");',
  '                    closeMappingModal();',
  '                    loadMappings();',
  '                } else {',
  '                    const err = await resp.json();',
  '                    showToast("Error: " + (err.error || JSON.stringify(err)), "error");',
  '                }',
  '            } catch (error) {',
  '                showToast("Error saving mapping: " + error, "error");',
  '            }',
  '        }',
  '',
  '        async function deleteMapping(id) {',
  '            if (!confirm("Delete this mapping?")) return;',
  '            try {',
  '                await fetch(`${API_BASE}/qbo-mappings?id=${id}`, { method: "DELETE" });',
  '                showToast("Mapping deleted", "success");',
  '                loadMappings();',
  '            } catch (error) {',
  '                showToast("Error: " + error, "error");',
  '            }',
  '        }',
  '',
  '        async function previewInvoices() {',
  '            const weekStart = document.getElementById("invoice-week-start").value;',
  '            if (!weekStart) { showToast("Select a week start date", "error"); return; }',
  '            try {',
  '                const resp = await fetch(`${API_BASE}/qbo-invoice-preview?week_start=${weekStart}`);',
  '                const data = await resp.json();',
  '                invoicePreviewData = data;',
  '                if (!data.invoices || data.invoices.length === 0) {',
  '                    document.getElementById("invoice-preview").innerHTML = "<p class=\\"text-gray-500\\">No invoices to generate for this period.</p>";',
  '                    document.getElementById("create-invoices-btn").classList.add("hidden");',
  '                    return;',
  '                }',
  '                let html = "<table class=\\"w-full text-sm\\"><thead><tr class=\\"text-left text-xs text-gray-500 border-b border-dark-600\\"><th class=\\"py-2\\">Customer</th><th class=\\"py-2\\">SIMs</th><th class=\\"py-2\\">Days</th><th class=\\"py-2\\">Rate</th><th class=\\"py-2\\">Total</th></tr></thead><tbody>";',
  '                data.invoices.forEach(inv => {',
  '                    html += `<tr class="border-b border-dark-700"><td class="py-2 text-gray-300">${inv.customer_name}</td><td class="py-2 text-gray-300">${inv.sim_count}</td><td class="py-2 text-gray-300">7</td><td class="py-2 text-gray-300">$${Number(inv.daily_rate).toFixed(2)}</td><td class="py-2 text-accent font-semibold">$${Number(inv.total).toFixed(2)}</td></tr>`;',
  '                });',
  '                html += "</tbody></table>";',
  '                document.getElementById("invoice-preview").innerHTML = html;',
  '                document.getElementById("create-invoices-btn").classList.remove("hidden");',
  '            } catch (error) {',
  '                showToast("Error previewing: " + error, "error");',
  '            }',
  '        }',
  '',
  '        async function createInvoices() {',
  '            if (!invoicePreviewData || !invoicePreviewData.invoices) return;',
  '            const weekStart = document.getElementById("invoice-week-start").value;',
  '            if (!confirm(`Create ${invoicePreviewData.invoices.length} invoice(s) in QuickBooks?`)) return;',
  '            try {',
  '                const resp = await fetch(`${API_BASE}/qbo/invoice/create`, {',
  '                    method: "POST",',
  '                    headers: { "Content-Type": "application/json" },',
  '                    body: JSON.stringify({ week_start: weekStart })',
  '                });',
  '                const result = await resp.json();',
  '                if (result.ok) {',
  '                    showToast(`Created ${result.created} invoice(s)`, "success");',
  '                    document.getElementById("create-invoices-btn").classList.add("hidden");',
  '                    loadInvoiceHistory();',
  '                } else {',
  '                    showToast("Error: " + (result.error || JSON.stringify(result)), "error");',
  '                }',
  '            } catch (error) {',
  '                showToast("Error creating invoices: " + error, "error");',
  '            }',
  '        }',
  '',
  '        async function loadInvoiceHistory() {',
  '            try {',
  '                const resp = await fetch(`${API_BASE}/qbo-invoices`);',
  '                if (!resp.ok) return;',
  '                const invoices = await resp.json();',
  '                const tbody = document.getElementById("invoice-history-table");',
  '                if (!invoices.length) { tbody.innerHTML = "<tr><td colspan=5 class=\\"px-4 py-4 text-center text-gray-500\\">No invoices yet</td></tr>"; return; }',
  '                tbody.innerHTML = invoices.map(inv => {',
  '                    const statusClass = {',
  '                        draft: "bg-gray-500/20 text-gray-400",',
  '                        sent: "bg-blue-500/20 text-blue-400",',
  '                        paid: "bg-accent/20 text-accent",',
  '                        error: "bg-red-500/20 text-red-400"',
  '                    }[inv.status] || "bg-gray-500/20 text-gray-400";',
  '                    return `',
  '                    <tr class="border-b border-dark-600">',
  '                        <td class="px-4 py-3 text-gray-300">${inv.customer_name || "-"}</td>',
  '                        <td class="px-4 py-3 text-gray-400 text-xs">${inv.week_start} - ${inv.week_end}</td>',
  '                        <td class="px-4 py-3 text-gray-300">${inv.sim_count}</td>',
  '                        <td class="px-4 py-3 text-accent">$${Number(inv.total).toFixed(2)}</td>',
  '                        <td class="px-4 py-3"><span class="px-2 py-1 text-xs font-medium rounded-full ${statusClass}">${inv.status}</span></td>',
  '                    </tr>`;',
  '                }).join("");',
  '            } catch (error) {',
  '                console.error("Error loading invoice history:", error);',
  '            }',
  '        }',
  '',
]);
console.log('[QBO-8] Added billing JS functions');

// ============================================================
// 9. Add QBO data endpoints (server-side: /api/qbo-mappings, /api/qbo-invoices, /api/qbo-invoice-preview)
// ============================================================
let qboRouteInsert = findLine("url.pathname.startsWith('/api/qbo/')");
if (qboRouteInsert === -1) throw new Error('Cannot find /api/qbo/ route');
let qboRouteEnd = qboRouteInsert;
while (qboRouteEnd < lines.length && !lines[qboRouteEnd - 1].match(/^\s{4}\}$/)) qboRouteEnd++;

insertAfterLine(qboRouteEnd, [
  '',
  "    if (url.pathname === '/api/qbo-mappings' && request.method === 'GET') {",
  '      return handleQboMappingsGet(env, corsHeaders);',
  '    }',
  '',
  "    if (url.pathname === '/api/qbo-mappings' && request.method === 'POST') {",
  '      return handleQboMappingsPost(request, env, corsHeaders);',
  '    }',
  '',
  "    if (url.pathname === '/api/qbo-mappings' && request.method === 'DELETE') {",
  '      return handleQboMappingsDelete(url, env, corsHeaders);',
  '    }',
  '',
  "    if (url.pathname === '/api/qbo-invoices') {",
  '      return handleQboInvoicesGet(env, corsHeaders);',
  '    }',
  '',
  "    if (url.pathname === '/api/qbo-invoice-preview') {",
  '      return handleQboInvoicePreview(url, env, corsHeaders);',
  '    }',
]);
console.log('[QBO-9] Added QBO data API routes');

// ============================================================
// 10. Add QBO data handler functions (before getHTML)
// ============================================================
getHTMLLine = findLine('function getHTML()');
insertBeforeLine(getHTMLLine, [
  'async function handleQboMappingsGet(env, corsHeaders) {',
  '  try {',
  '    const query = `qbo_customer_map?select=id,reseller_id,customer_name,qbo_customer_id,qbo_display_name,daily_rate,resellers(name)&order=id.desc`;',
  '    const response = await supabaseGet(env, query);',
  '    const data = await response.json();',
  '    const mapped = (Array.isArray(data) ? data : []).map(m => ({',
  '      ...m,',
  '      reseller_name: m.resellers?.name || null,',
  '    }));',
  '    return new Response(JSON.stringify(mapped), {',
  "      headers: { ...corsHeaders, 'Content-Type': 'application/json' }",
  '    });',
  '  } catch (error) {',
  '    return new Response(JSON.stringify({ error: String(error) }), {',
  '      status: 500,',
  "      headers: { ...corsHeaders, 'Content-Type': 'application/json' }",
  '    });',
  '  }',
  '}',
  '',
  'async function handleQboMappingsPost(request, env, corsHeaders) {',
  '  try {',
  '    const body = await request.json();',
  '    const { reseller_id, qbo_customer_id, qbo_display_name, daily_rate } = body;',
  "    if (!qbo_customer_id) return new Response(JSON.stringify({ error: 'qbo_customer_id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });",
  '    const insertResp = await fetch(`${env.SUPABASE_URL}/rest/v1/qbo_customer_map`, {',
  "      method: 'POST',",
  '      headers: {',
  '        apikey: env.SUPABASE_SERVICE_ROLE_KEY,',
  '        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,',
  "        'Content-Type': 'application/json',",
  "        Prefer: 'return=representation',",
  '      },',
  '      body: JSON.stringify({ reseller_id: reseller_id || null, qbo_customer_id, qbo_display_name, daily_rate: daily_rate || 0.50 }),',
  '    });',
  '    const inserted = await insertResp.json();',
  '    return new Response(JSON.stringify(inserted), {',
  "      headers: { ...corsHeaders, 'Content-Type': 'application/json' }",
  '    });',
  '  } catch (error) {',
  '    return new Response(JSON.stringify({ error: String(error) }), {',
  '      status: 500,',
  "      headers: { ...corsHeaders, 'Content-Type': 'application/json' }",
  '    });',
  '  }',
  '}',
  '',
  'async function handleQboMappingsDelete(url, env, corsHeaders) {',
  '  try {',
  "    const id = url.searchParams.get('id');",
  "    if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });",
  '    await fetch(`${env.SUPABASE_URL}/rest/v1/qbo_customer_map?id=eq.${id}`, {',
  "      method: 'DELETE',",
  '      headers: {',
  '        apikey: env.SUPABASE_SERVICE_ROLE_KEY,',
  '        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,',
  '      },',
  '    });',
  '    return new Response(JSON.stringify({ ok: true }), {',
  "      headers: { ...corsHeaders, 'Content-Type': 'application/json' }",
  '    });',
  '  } catch (error) {',
  '    return new Response(JSON.stringify({ error: String(error) }), {',
  '      status: 500,',
  "      headers: { ...corsHeaders, 'Content-Type': 'application/json' }",
  '    });',
  '  }',
  '}',
  '',
  'async function handleQboInvoicesGet(env, corsHeaders) {',
  '  try {',
  '    const query = `qbo_invoices?select=id,week_start,week_end,sim_count,total,status,error_message,qbo_customer_map(qbo_display_name)&order=created_at.desc&limit=50`;',
  '    const response = await supabaseGet(env, query);',
  '    const data = await response.json();',
  '    const mapped = (Array.isArray(data) ? data : []).map(inv => ({',
  '      ...inv,',
  '      customer_name: inv.qbo_customer_map?.qbo_display_name || null,',
  '    }));',
  '    return new Response(JSON.stringify(mapped), {',
  "      headers: { ...corsHeaders, 'Content-Type': 'application/json' }",
  '    });',
  '  } catch (error) {',
  '    return new Response(JSON.stringify({ error: String(error) }), {',
  '      status: 500,',
  "      headers: { ...corsHeaders, 'Content-Type': 'application/json' }",
  '    });',
  '  }',
  '}',
  '',
  'async function handleQboInvoicePreview(url, env, corsHeaders) {',
  '  try {',
  "    const weekStart = url.searchParams.get('week_start');",
  "    if (!weekStart) return new Response(JSON.stringify({ error: 'week_start required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });",
  '',
  '    // Get all mappings',
  '    const mapResp = await supabaseGet(env, `qbo_customer_map?select=id,reseller_id,customer_name,qbo_display_name,daily_rate`);',
  '    const mappings = await mapResp.json();',
  '',
  '    const invoices = [];',
  '    for (const m of mappings) {',
  '      // Count active SIMs for this reseller',
  '      let simCount = 0;',
  '      if (m.reseller_id) {',
  "        const simResp = await supabaseGet(env, `reseller_sims?select=sim_id,sims(status)&reseller_id=eq.${m.reseller_id}&active=eq.true&sims.status=in.(active,ACTIVATED)`);",
  '        const sims = await simResp.json();',
  '        simCount = Array.isArray(sims) ? sims.filter(s => s.sims).length : 0;',
  '      }',
  '      if (simCount > 0) {',
  '        invoices.push({',
  '          mapping_id: m.id,',
  '          customer_name: m.qbo_display_name,',
  '          sim_count: simCount,',
  '          daily_rate: m.daily_rate,',
  '          total: simCount * 7 * parseFloat(m.daily_rate),',
  '        });',
  '      }',
  '    }',
  '    return new Response(JSON.stringify({ invoices }), {',
  "      headers: { ...corsHeaders, 'Content-Type': 'application/json' }",
  '    });',
  '  } catch (error) {',
  '    return new Response(JSON.stringify({ error: String(error) }), {',
  '      status: 500,',
  "      headers: { ...corsHeaders, 'Content-Type': 'application/json' }",
  '    });',
  '  }',
  '}',
  '',
]);
console.log('[QBO-10] Added QBO data handler functions');

// ============================================================
// Final: escape template syntax in <script> block and write
// ============================================================
const getHtmlIdx = lines.findIndex(l => l.includes('function getHTML()'));
let scriptStartIdx = -1, scriptEndIdx = -1;
for (let i = getHtmlIdx; i < lines.length; i++) {
  if (lines[i].trim().startsWith('<script>') && !lines[i].includes('src=')) {
    const endIdx = lines.findIndex((l, j) => j > i && l.trim().startsWith('</script>'));
    if (endIdx !== -1 && (endIdx - i) > 50) {
      scriptStartIdx = i;
      scriptEndIdx = endIdx;
    }
  }
}
if (scriptStartIdx !== -1 && scriptEndIdx !== -1) {
  let escapedCount = 0;
  for (let i = scriptStartIdx + 1; i < scriptEndIdx; i++) {
    const original = lines[i];
    let line = original;
    line = line.replace(/\\`/g, '`');
    line = line.replace(/\\\${/g, '${');
    line = line.replace(/`/g, '\\`');
    line = line.replace(/\${/g, '\\${');
    if (line !== original) escapedCount++;
    lines[i] = line;
  }
  console.log(`[QBO-ESC] Re-escaped ${escapedCount} lines in <script> block`);
}

content = lines.join('\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log(`\n=== QBO patch done! Applied ${changeCount} changes. ===`);
