'use strict';
const fs = require('fs');
const path = require('path');
const filePath = path.join(__dirname, 'src', 'dashboard', 'index.js');

let content = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');

const BT = '\\`';
const DS = '\\${';

// Wrong: bare template literal \`<button...>\`
const oldBtn =
  '                        ' + BT +
  '<button onclick="showSetStatusModal(' + DS + 'sim.id}, \'' + DS + "sim.status}')" +
  '" class="px-2 py-1 text-xs bg-gray-600 hover:bg-gray-500 text-white rounded transition ml-1">Status</button>' + BT;

// Fixed: wrapped in \${...} so it's a proper template expression
const newBtn =
  '                        ' + DS + BT +
  '<button onclick="showSetStatusModal(' + DS + 'sim.id}, \'' + DS + "sim.status}')" +
  '" class="px-2 py-1 text-xs bg-gray-600 hover:bg-gray-500 text-white rounded transition ml-1">Status</button>' + BT + '}';

if (!content.includes(oldBtn)) throw new Error('Button anchor not found — already fixed or wrong pattern');
content = content.replace(oldBtn, newBtn);

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Fixed.');
