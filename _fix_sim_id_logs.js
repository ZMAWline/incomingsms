// Patch: make SIM ID clickable in SIM table to open Helix logs modal
const fs = require('fs');
const path = require('path');

const dashPath = path.join(__dirname, 'src', 'dashboard', 'index.js');
let dash = fs.readFileSync(dashPath, 'utf8').replace(/\r\n/g, '\n');

// 1. Make SIM ID cell a clickable button
const OLD_ID_CELL = '<td class="px-4 py-3 text-gray-300">\\${sim.id}</td>';
if (!dash.includes(OLD_ID_CELL)) {
  console.error('Cannot find SIM ID cell'); process.exit(1);
}
const NEW_ID_CELL =
  '<td class="px-4 py-3">' +
  '<button onclick="showSimLogs(\\${sim.id})" ' +
  'class="text-indigo-400 hover:text-indigo-200 hover:underline font-mono transition" ' +
  'title="View Helix logs">\\${sim.id}</button>' +
  '</td>';
dash = dash.replace(OLD_ID_CELL, NEW_ID_CELL);

// 2. Add showSimLogs function after hideSimActionModal
const OLD_HIDE =
  '            document.getElementById(\'sim-action-modal\').classList.add(\'hidden\');\n' +
  '        }';
if (!dash.includes(OLD_HIDE)) {
  console.error('Cannot find hideSimActionModal body'); process.exit(1);
}
const NEW_HIDE =
  '            document.getElementById(\'sim-action-modal\').classList.add(\'hidden\');\n' +
  '        }\n' +
  '\n' +
  '        function showSimLogs(simId) {\n' +
  '            const sim = tableState.sims?.data?.find(s => String(s.id) === String(simId));\n' +
  '            currentSimActionId = simId;\n' +
  '            currentSimActionIccid = sim?.iccid || null;\n' +
  '            document.getElementById(\'sim-action-title\').textContent = \'Helix Logs \u2014 SIM #\' + simId;\n' +
  '            document.getElementById(\'sim-action-output\').textContent = \'\';\n' +
  '            document.getElementById(\'sim-action-output\').classList.add(\'hidden\');\n' +
  '            document.getElementById(\'sim-action-logs-section\').classList.remove(\'hidden\');\n' +
  '            document.getElementById(\'sim-action-modal\').classList.remove(\'hidden\');\n' +
  '            loadSimActionLogs();\n' +
  '        }';
dash = dash.replace(OLD_HIDE, NEW_HIDE);

// 3. When the sim-action-modal is hidden again, restore the output pre visibility
//    (so normal actions still show the output block)
//    Find hideSimActionModal and add the restore line
const OLD_HIDE2 =
  '            document.getElementById(\'sim-action-modal\').classList.add(\'hidden\');\n' +
  '        }\n' +
  '\n' +
  '        function showSimLogs';
if (!dash.includes(OLD_HIDE2)) {
  console.error('Cannot find hideSimActionModal to add restore'); process.exit(1);
}
const NEW_HIDE2 =
  '            document.getElementById(\'sim-action-modal\').classList.add(\'hidden\');\n' +
  '            document.getElementById(\'sim-action-output\').classList.remove(\'hidden\');\n' +
  '        }\n' +
  '\n' +
  '        function showSimLogs';
dash = dash.replace(OLD_HIDE2, NEW_HIDE2);

fs.writeFileSync(dashPath, dash.replace(/\n/g, '\r\n'), 'utf8');
console.log('dashboard patched.');
