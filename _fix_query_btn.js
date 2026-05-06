// Add Query button after Status button
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');

content = content.replace(/\r\n/g, '\n');

// The exact line to find (Status button)
const oldLine = '                        ${`<button onclick="showSetStatusModal(${sim.id}, ' + "'" + '${sim.status}' + "'" + ')" class="px-2 py-1 text-xs bg-gray-600 hover:bg-gray-500 text-white rounded transition ml-1">Status</button>`}';

// Add Query button on new line after Status
const newLines = '                        ${`<button onclick="showSetStatusModal(${sim.id}, ' + "'" + '${sim.status}' + "'" + ')" class="px-2 py-1 text-xs bg-gray-600 hover:bg-gray-500 text-white rounded transition ml-1">Status</button>`}\n' +
'                        ${`<button onclick="querySimCarrier(${sim.id}, ' + "'" + '${sim.vendor}' + "'" + ', ' + "'" + '${sim.mobility_subscription_id || ' + "'" + "'" + '}' + "'" + ', ' + "'" + '${sim.iccid}' + "'" + ')" class="px-2 py-1 text-xs bg-cyan-600 hover:bg-cyan-500 text-white rounded transition ml-1">Query</button>`}';

if (content.includes(oldLine)) {
  content = content.replace(oldLine, newLines);
  console.log('Added Query button');
} else {
  console.log('Pattern not found, trying alternate approach');
  // Try a simpler pattern
  const simpleOld = 'ml-1">Status</button>`}';
  const simpleNew = 'ml-1">Status</button>`}\n                        ${`<button onclick="querySimCarrier(${sim.id}, ' + "'" + '${sim.vendor}' + "'" + ', ' + "'" + '${sim.mobility_subscription_id || ' + "'" + "'" + '}' + "'" + ', ' + "'" + '${sim.iccid}' + "'" + ')" class="px-2 py-1 text-xs bg-cyan-600 hover:bg-cyan-500 text-white rounded transition ml-1">Query</button>`}';

  if (content.includes(simpleOld) && !content.includes('querySimCarrier(${sim.id}')) {
    content = content.replace(simpleOld, simpleNew);
    console.log('Added Query button (simple pattern)');
  } else {
    console.log('Could not find pattern');
  }
}

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
