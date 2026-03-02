// Patch 1: mdn-rotator — gateway discovery + port conversion before queuing fix
const fs = require('fs');
const path = require('path');

// ─── mdn-rotator ──────────────────────────────────────────────────────────
const rotPath = path.join(__dirname, 'src', 'mdn-rotator', 'index.js');
let rot = fs.readFileSync(rotPath, 'utf8').replace(/\r\n/g, '\n');

const OLD_FIX_HANDLER =
  '        // For fix, send to dedicated queue so it runs outside the\n' +
  '        // 30-second service-binding wall-clock limit.\n' +
  '        if (action === "fix") {\n' +
  '          if (!env.FIX_SIM_QUEUE) {\n' +
  '            return new Response(JSON.stringify({ ok: false, error: "FIX_SIM_QUEUE binding not configured" }), {\n' +
  '              status: 500, headers: { "Content-Type": "application/json" }\n' +
  '            });\n' +
  '          }\n' +
  '          await env.FIX_SIM_QUEUE.send({ sim_id, iccid });\n' +
  '          return new Response(JSON.stringify({\n' +
  '            ok: true,\n' +
  '            running: true,\n' +
  '            message: "Fix queued — check the Helix API Logs below to confirm each step completed.",\n' +
  '            action, sim_id, iccid\n' +
  '          }, null, 2), {\n' +
  '            status: 200,\n' +
  '            headers: { "Content-Type": "application/json" }\n' +
  '          });\n' +
  '        }';

if (!rot.includes(OLD_FIX_HANDLER)) {
  console.error('Cannot find fix handler in mdn-rotator'); process.exit(1);
}

const NEW_FIX_HANDLER =
  '        // For fix, resolve gateway/port first, then send to dedicated queue.\n' +
  '        if (action === "fix") {\n' +
  '          if (!env.FIX_SIM_QUEUE) {\n' +
  '            return new Response(JSON.stringify({ ok: false, error: "FIX_SIM_QUEUE binding not configured" }), {\n' +
  '              status: 500, headers: { "Content-Type": "application/json" }\n' +
  '            });\n' +
  '          }\n' +
  '\n' +
  '          let gwId = sim.gateway_id;\n' +
  '          let gwPort = sim.port;\n' +
  '\n' +
  '          // Manual slot provided (from slot picker modal)\n' +
  '          if (body.gateway_id && body.port) {\n' +
  '            gwId = parseInt(body.gateway_id, 10) || body.gateway_id;\n' +
  '            gwPort = dotPortToLetter(String(body.port)); // "13.03" → "13C"\n' +
  '            await supabasePatch(env, `sims?id=eq.${encodeURIComponent(String(sim_id))}`, { gateway_id: gwId, port: gwPort });\n' +
  '            console.log(`[SimAction/fix] SIM ${iccid}: persisted manual slot gateway_id=${gwId} port=${gwPort}`);\n' +
  '          } else if (!gwId || !gwPort) {\n' +
  '            // Auto-scan gateways for this ICCID\n' +
  '            console.log(`[SimAction/fix] SIM ${iccid}: no gateway/port — scanning gateways...`);\n' +
  '            const found = await scanGatewaysForIccid(env, iccid);\n' +
  '            if (found) {\n' +
  '              gwId = found.gateway_id;\n' +
  '              gwPort = found.port;\n' +
  '              await supabasePatch(env, `sims?id=eq.${encodeURIComponent(String(sim_id))}`, { gateway_id: gwId, port: gwPort });\n' +
  '              console.log(`[SimAction/fix] SIM ${iccid}: discovered gateway_id=${gwId} port=${gwPort}`);\n' +
  '            } else {\n' +
  '              return new Response(JSON.stringify({\n' +
  '                ok: false,\n' +
  '                slot_not_found: true,\n' +
  '                message: "SIM not found on any gateway. Please enter the slot manually.",\n' +
  '                sim_id, iccid\n' +
  '              }), { status: 200, headers: { "Content-Type": "application/json" } });\n' +
  '            }\n' +
  '          }\n' +
  '\n' +
  '          await env.FIX_SIM_QUEUE.send({ sim_id, iccid });\n' +
  '          return new Response(JSON.stringify({\n' +
  '            ok: true,\n' +
  '            running: true,\n' +
  '            message: "Fix queued — check the Helix API Logs below to confirm each step completed.",\n' +
  '            action, sim_id, iccid\n' +
  '          }, null, 2), {\n' +
  '            status: 200,\n' +
  '            headers: { "Content-Type": "application/json" }\n' +
  '          });\n' +
  '        }';

rot = rot.replace(OLD_FIX_HANDLER, NEW_FIX_HANDLER);
fs.writeFileSync(rotPath, rot.replace(/\n/g, '\r\n'), 'utf8');
console.log('mdn-rotator patched.');

// ─── dashboard ────────────────────────────────────────────────────────────
const dashPath = path.join(__dirname, 'src', 'dashboard', 'index.js');
let dash = fs.readFileSync(dashPath, 'utf8').replace(/\r\n/g, '\n');

// 1. In simAction: detect slot_not_found for fix and open slot picker
const OLD_SIM_ACTION_RESULT =
  '                document.getElementById(\'sim-action-output\').textContent = JSON.stringify(result, null, 2);\n' +
  '\n' +
  '                if (result.ok) {\n' +
  '                    showToast(\\`\\${action} completed successfully\\`, \'success\');\n' +
  '                    loadErrors();\n' +
  '                } else {\n' +
  '                    showToast(\\`Error: \\${result.error || \'Action failed\'}\\`, \'error\');\n' +
  '                }';

if (!dash.includes(OLD_SIM_ACTION_RESULT)) {
  console.error('Cannot find simAction result block'); process.exit(1);
}

const NEW_SIM_ACTION_RESULT =
  '                if (result.slot_not_found) {\n' +
  '                    hideSimActionModal();\n' +
  '                    showSlotPickerModal(simId, [], \'fix\');\n' +
  '                    return;\n' +
  '                }\n' +
  '\n' +
  '                document.getElementById(\'sim-action-output\').textContent = JSON.stringify(result, null, 2);\n' +
  '\n' +
  '                if (result.ok) {\n' +
  '                    showToast(\\`\\${action} completed successfully\\`, \'success\');\n' +
  '                    loadErrors();\n' +
  '                } else {\n' +
  '                    showToast(\\`Error: \\${result.error || \'Action failed\'}\\`, \'error\');\n' +
  '                }';

dash = dash.replace(OLD_SIM_ACTION_RESULT, NEW_SIM_ACTION_RESULT);

// 2. Add _slotPickerMode variable alongside _slotPickerSimId
const OLD_SLOT_VAR = "        let _slotPickerSimId = null;";
if (!dash.includes(OLD_SLOT_VAR)) {
  console.error('Cannot find _slotPickerSimId declaration'); process.exit(1);
}
dash = dash.replace(OLD_SLOT_VAR, "        let _slotPickerSimId = null;\n        let _slotPickerMode = 'retry';");

// 3. showSlotPickerModal: accept mode param and store it
const OLD_SHOW_SLOT = "        function showSlotPickerModal(simId, candidates) {\n            _slotPickerSimId = simId;";
if (!dash.includes(OLD_SHOW_SLOT)) {
  console.error('Cannot find showSlotPickerModal signature'); process.exit(1);
}
dash = dash.replace(
  OLD_SHOW_SLOT,
  "        function showSlotPickerModal(simId, candidates, mode) {\n            _slotPickerMode = mode || 'retry';\n            _slotPickerSimId = simId;"
);

// 4. useManualSlot: route to fixSimWithSlot when in fix mode
const OLD_USE_MANUAL =
  '        function useManualSlot() {\n' +
  '            const gwId = document.getElementById(\'slot-picker-manual-gw\').value.trim();\n' +
  '            const port = document.getElementById(\'slot-picker-manual-port\').value.trim();\n' +
  '            if (!gwId || !port) { showToast(\'Enter gateway ID and port\', \'error\'); return; }\n' +
  '            const simId = _slotPickerSimId;\n' +
  '            hideSlotPickerModal();\n' +
  '            retryActivation(simId, gwId, port);\n' +
  '        }';

if (!dash.includes(OLD_USE_MANUAL)) {
  console.error('Cannot find useManualSlot'); process.exit(1);
}

const NEW_USE_MANUAL =
  '        function useManualSlot() {\n' +
  '            const gwId = document.getElementById(\'slot-picker-manual-gw\').value.trim();\n' +
  '            const port = document.getElementById(\'slot-picker-manual-port\').value.trim();\n' +
  '            if (!gwId || !port) { showToast(\'Enter gateway ID and port\', \'error\'); return; }\n' +
  '            const simId = _slotPickerSimId;\n' +
  '            hideSlotPickerModal();\n' +
  '            if (_slotPickerMode === \'fix\') {\n' +
  '                fixSimWithSlot(simId, gwId, port);\n' +
  '            } else {\n' +
  '                retryActivation(simId, gwId, port);\n' +
  '            }\n' +
  '        }';

dash = dash.replace(OLD_USE_MANUAL, NEW_USE_MANUAL);

// 5. Add fixSimWithSlot function after useManualSlot
const AFTER_USE_MANUAL = NEW_USE_MANUAL;
const FIX_WITH_SLOT_FN =
  '\n\n        async function fixSimWithSlot(simId, gatewayId, port) {\n' +
  '            const sim = tableState.sims?.data?.find(s => String(s.id) === String(simId));\n' +
  '            currentSimActionId = simId;\n' +
  '            currentSimActionIccid = sim?.iccid || null;\n' +
  '            document.getElementById(\'sim-action-title\').textContent = \\`fix - SIM #\\${simId}\\`;\n' +
  '            document.getElementById(\'sim-action-output\').textContent = \'Queuing fix...\';\n' +
  '            document.getElementById(\'sim-action-logs-section\').classList.add(\'hidden\');\n' +
  '            document.getElementById(\'sim-action-modal\').classList.remove(\'hidden\');\n' +
  '            try {\n' +
  '                const response = await fetch(\\`\\${API_BASE}/sim-action\\`, {\n' +
  '                    method: \'POST\',\n' +
  '                    headers: { \'Content-Type\': \'application/json\' },\n' +
  '                    body: JSON.stringify({ sim_id: simId, action: \'fix\', gateway_id: gatewayId, port })\n' +
  '                });\n' +
  '                const result = await response.json();\n' +
  '                document.getElementById(\'sim-action-output\').textContent = JSON.stringify(result, null, 2);\n' +
  '                if (result.ok) {\n' +
  '                    showToast(\'Fix queued successfully\', \'success\');\n' +
  '                } else {\n' +
  '                    showToast(\'Fix failed: \' + (result.error || \'Unknown error\'), \'error\');\n' +
  '                }\n' +
  '            } catch (error) {\n' +
  '                document.getElementById(\'sim-action-output\').textContent = String(error);\n' +
  '                showToast(\'Error queuing fix\', \'error\');\n' +
  '            }\n' +
  '            loadSimActionLogs();\n' +
  '        }';

dash = dash.replace(AFTER_USE_MANUAL, AFTER_USE_MANUAL + FIX_WITH_SLOT_FN);

fs.writeFileSync(dashPath, dash.replace(/\n/g, '\r\n'), 'utf8');
console.log('dashboard patched.');
