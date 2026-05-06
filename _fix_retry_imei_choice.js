// _fix_retry_imei_choice.js
// Adds IMEI strategy choice (Same / New from Pool) to retry activation flow.
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

const BT = '\\' + '`';  // writes \` to file (escaped backtick inside getHTML template)
const DS = '\\${';       // writes \${ to file

// ── Patch 1: Add showImeiStrategyChoice before handleConfirm ─────────────────
const OLD1 =
    '        function handleConfirm(confirmed) {\n' +
    '            const modal = document.getElementById(\'confirm-modal\');';

const NEW1 =
    '        async function showImeiStrategyChoice(simCount) {\n' +
    '            return new Promise(function(resolve) {\n' +
    '                var overlay = document.createElement(\'div\');\n' +
    '                overlay.className = \'fixed inset-0 bg-black/70 z-50 flex items-center justify-center\';\n' +
    '                overlay.innerHTML =\n' +
    '                    \'<div class="bg-dark-800 border border-dark-600 rounded-xl p-6 max-w-sm w-full mx-4">\' +\n' +
    '                    \'<h3 class="text-white font-semibold text-lg mb-2">IMEI Strategy</h3>\' +\n' +
    '                    \'<p class="text-gray-300 text-sm mb-5">Choose which IMEI to use for \' + simCount + \' SIM(s):</p>\' +\n' +
    '                    \'<div class="flex flex-col gap-2">\' +\n' +
    '                    \'<button id="_isc-same" class="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded transition text-left">Same IMEI &mdash; <span class="text-blue-200 text-xs">reuse the IMEI that failed</span></button>\' +\n' +
    '                    \'<button id="_isc-new" class="px-4 py-2 text-sm bg-green-600 hover:bg-green-700 text-white rounded transition text-left">New from Pool &mdash; <span class="text-green-200 text-xs">retire old IMEI, allocate a fresh one</span></button>\' +\n' +
    '                    \'<button id="_isc-cancel" class="px-4 py-2 text-sm bg-dark-600 hover:bg-dark-500 text-gray-300 rounded transition mt-1">Cancel</button>\' +\n' +
    '                    \'</div></div>\';\n' +
    '                document.body.appendChild(overlay);\n' +
    '                function cleanup(val) { document.body.removeChild(overlay); resolve(val); }\n' +
    '                overlay.querySelector(\'#_isc-same\').onclick = function() { cleanup(\'same\'); };\n' +
    '                overlay.querySelector(\'#_isc-new\').onclick = function() { cleanup(\'new\'); };\n' +
    '                overlay.querySelector(\'#_isc-cancel\').onclick = function() { cleanup(null); };\n' +
    '                overlay.addEventListener(\'click\', function(e) { if (e.target === overlay) cleanup(null); });\n' +
    '            });\n' +
    '        }\n' +
    '        function handleConfirm(confirmed) {\n' +
    '            const modal = document.getElementById(\'confirm-modal\');';

if (!content.includes(OLD1)) { console.error('PATCH 1 FAILED: handleConfirm anchor not found'); process.exit(1); }
content = content.replace(OLD1, NEW1);
console.log('Patch 1 OK: showImeiStrategyChoice added');

// ── Patch 2: Modify simAction to intercept retry_activation with strategy choice
const OLD2 =
    '        async function simAction(simId, action, skipConfirm = false) {\n' +
    '            if (!skipConfirm && !(await showConfirm(\'Run Action\', ' + BT + 'Run ' + DS + 'action} on SIM #' + DS + 'simId}?' + BT + '))) return;\n' +
    '\n' +
    '            const sim = tableState.sims?.data?.find(s => String(s.id) === String(simId));\n' +
    '            currentSimActionId = simId;\n' +
    '            currentSimActionIccid = sim?.iccid || null;\n' +
    '\n' +
    '            document.getElementById(\'sim-action-title\').textContent = ' + BT + DS + 'action} - SIM #' + DS + 'simId}' + BT + ';\n' +
    '            document.getElementById(\'sim-action-output\').textContent = ' + BT + 'Running ' + DS + 'action}...' + BT + ';\n' +
    '            document.getElementById(\'sim-action-logs-section\').classList.add(\'hidden\');\n' +
    '            document.getElementById(\'sim-action-modal\').classList.remove(\'hidden\');\n' +
    '\n' +
    '            try {\n' +
    '                const response = await fetch(' + BT + DS + 'API_BASE}/sim-action' + BT + ', {\n' +
    '                    method: \'POST\',\n' +
    '                    headers: { \'Content-Type\': \'application/json\' },\n' +
    '                    body: JSON.stringify({ sim_id: simId, action })\n' +
    '                });';

const NEW2 =
    '        async function simAction(simId, action, skipConfirm = false, extraBody = {}) {\n' +
    '            if (action === \'retry_activation\') {\n' +
    '                var strategy = await showImeiStrategyChoice(1);\n' +
    '                if (strategy === null) return;\n' +
    '                extraBody = { imei_strategy: strategy };\n' +
    '            } else if (!skipConfirm && !(await showConfirm(\'Run Action\', ' + BT + 'Run ' + DS + 'action} on SIM #' + DS + 'simId}?' + BT + '))) return;\n' +
    '\n' +
    '            const sim = tableState.sims?.data?.find(s => String(s.id) === String(simId));\n' +
    '            currentSimActionId = simId;\n' +
    '            currentSimActionIccid = sim?.iccid || null;\n' +
    '\n' +
    '            document.getElementById(\'sim-action-title\').textContent = ' + BT + DS + 'action} - SIM #' + DS + 'simId}' + BT + ';\n' +
    '            document.getElementById(\'sim-action-output\').textContent = ' + BT + 'Running ' + DS + 'action}...' + BT + ';\n' +
    '            document.getElementById(\'sim-action-logs-section\').classList.add(\'hidden\');\n' +
    '            document.getElementById(\'sim-action-modal\').classList.remove(\'hidden\');\n' +
    '\n' +
    '            try {\n' +
    '                const response = await fetch(' + BT + DS + 'API_BASE}/sim-action' + BT + ', {\n' +
    '                    method: \'POST\',\n' +
    '                    headers: { \'Content-Type\': \'application/json\' },\n' +
    '                    body: JSON.stringify(Object.assign({ sim_id: simId, action }, extraBody))\n' +
    '                });';

if (!content.includes(OLD2)) { console.error('PATCH 2 FAILED: simAction not found'); process.exit(1); }
content = content.replace(OLD2, NEW2);
console.log('Patch 2 OK: simAction updated');

// ── Patch 3: Modify retryActivation to ask strategy before opening the modal ──
const OLD3 =
    '        async function retryActivation(simId, gatewayId, port) {\n' +
    '            const sim = tableState.sims?.data?.find(s => String(s.id) === String(simId));\n' +
    '            currentSimActionId = simId;\n' +
    '            currentSimActionIccid = sim?.iccid || null;\n' +
    '\n' +
    '            document.getElementById(\'sim-action-title\').textContent = \'Retry Activation - SIM #\' + simId;\n' +
    '            document.getElementById(\'sim-action-output\').textContent = \'Scanning gateways for SIM...\';\n' +
    '            document.getElementById(\'sim-action-logs-section\').classList.add(\'hidden\');\n' +
    '            document.getElementById(\'sim-action-modal\').classList.remove(\'hidden\');\n' +
    '\n' +
    '            try {\n' +
    '                const reqBody = { sim_id: simId, action: \'retry_activation\' };\n' +
    '                if (gatewayId) reqBody.gateway_id = gatewayId;\n' +
    '                if (port) reqBody.port = port;';

const NEW3 =
    '        async function retryActivation(simId, gatewayId, port) {\n' +
    '            var _strategy = await showImeiStrategyChoice(1);\n' +
    '            if (_strategy === null) return;\n' +
    '\n' +
    '            const sim = tableState.sims?.data?.find(s => String(s.id) === String(simId));\n' +
    '            currentSimActionId = simId;\n' +
    '            currentSimActionIccid = sim?.iccid || null;\n' +
    '\n' +
    '            document.getElementById(\'sim-action-title\').textContent = \'Retry Activation - SIM #\' + simId;\n' +
    '            document.getElementById(\'sim-action-output\').textContent = \'Scanning gateways for SIM...\';\n' +
    '            document.getElementById(\'sim-action-logs-section\').classList.add(\'hidden\');\n' +
    '            document.getElementById(\'sim-action-modal\').classList.remove(\'hidden\');\n' +
    '\n' +
    '            try {\n' +
    '                const reqBody = { sim_id: simId, action: \'retry_activation\', imei_strategy: _strategy };\n' +
    '                if (gatewayId) reqBody.gateway_id = gatewayId;\n' +
    '                if (port) reqBody.port = port;';

if (!content.includes(OLD3)) { console.error('PATCH 3 FAILED: retryActivation not found'); process.exit(1); }
content = content.replace(OLD3, NEW3);
console.log('Patch 3 OK: retryActivation updated');

// ── Patch 4a: bulkRetryActivation — replace showConfirm with strategy choice ──
const OLD4a =
    '            if (!(await showConfirm(\'Retry Activation\', \'Retry activation for \' + simIds.length + \' SIM(s)?\'))) return;\n' +
    '\n' +
    '            // Show results in sim-action-modal (same modal per-row Retry uses)';

const NEW4a =
    '            var _bulkStrategy = await showImeiStrategyChoice(simIds.length);\n' +
    '            if (_bulkStrategy === null) return;\n' +
    '\n' +
    '            // Show results in sim-action-modal (same modal per-row Retry uses)';

if (!content.includes(OLD4a)) { console.error('PATCH 4a FAILED: bulkRetryActivation confirm not found'); process.exit(1); }
content = content.replace(OLD4a, NEW4a);
console.log('Patch 4a OK: bulkRetryActivation confirm replaced');

// ── Patch 4b: bulkRetryActivation — add imei_strategy to fetch body ───────────
const OLD4b = '                        body: JSON.stringify({ sim_id: simId, action: \'retry_activation\' })';
const NEW4b = '                        body: JSON.stringify({ sim_id: simId, action: \'retry_activation\', imei_strategy: _bulkStrategy })';

if (!content.includes(OLD4b)) { console.error('PATCH 4b FAILED: bulk retry body not found'); process.exit(1); }
content = content.replace(OLD4b, NEW4b);
console.log('Patch 4b OK: bulkRetryActivation body updated');

// ── Patch 5: Update guide text from Helix-only to vendor-agnostic ─────────────
const OLD5 =
    '                        <p>Retries a failed activation on Helix. The SIM must have a <code class="bg-dark-900 px-1 rounded text-accent">mobility_subscription_id</code> and the subscription must be in <span class="text-red-400">ACTIVATION_FAILED</span> status on the Helix side.</p>\n' +
    '                        <ol class="list-decimal list-inside space-y-1 ml-2">\n' +
    '                            <li>Dashboard sends <code class="bg-dark-900 px-1 rounded text-accent">action: "retry_activation"</code> to mdn-rotator</li>\n' +
    '                            <li>Worker calls Helix retry endpoint (<code class="bg-dark-900 px-1 rounded text-accent">PATCH /api/mobility-activation/activate/{subscriptionId}</code>) with corrected ICCID/IMEI</li>\n' +
    '                            <li>On success, SIM status is set back to <span class="text-yellow-400">provisioning</span></li>\n' +
    '                            <li>The details-finalizer will later pick it up and finalize (get phone number, set to active)</li>\n' +
    '                        </ol>';

const NEW5 =
    '                        <p>Retries a failed SIM activation via the carrier API (ATOMIC for AT&amp;T, Wing IoT for IoT SIMs). The SIM must be in <span class="text-red-400">error</span> status.</p>\n' +
    '                        <p class="mt-1">You will be prompted to choose an IMEI strategy:</p>\n' +
    '                        <ul class="list-disc list-inside space-y-1 ml-2">\n' +
    '                            <li><span class="text-blue-400 font-medium">Same IMEI</span> &mdash; reuses the IMEI that failed (skips pool retire/allocate). Use when the issue was a transient API error, not an IMEI problem.</li>\n' +
    '                            <li><span class="text-green-400 font-medium">New from Pool</span> &mdash; retires the old IMEI and allocates a fresh one. Use when the IMEI itself may be the cause of the error.</li>\n' +
    '                        </ul>\n' +
    '                        <ol class="list-decimal list-inside space-y-1 ml-2 mt-2">\n' +
    '                            <li>Worker locates the SIM on a gateway (or uses the slot you provide)</li>\n' +
    '                            <li>Sets the chosen IMEI on the gateway port</li>\n' +
    '                            <li>Calls the carrier activation API (ATOMIC: re-activates and returns MSISDN; Wing IoT: PUT activated status)</li>\n' +
    '                            <li>On success, SIM status is set to <span class="text-green-400">active</span> with the new phone number</li>\n' +
    '                        </ol>';

if (!content.includes(OLD5)) { console.error('PATCH 5 FAILED: guide text not found'); process.exit(1); }
content = content.replace(OLD5, NEW5);
console.log('Patch 5 OK: guide text updated');

// ── Write back (CRLF) ─────────────────────────────────────────────────────────
content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('\nAll patches applied. Run both syntax checks now.');
