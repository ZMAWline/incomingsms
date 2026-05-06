const fs = require('fs'), path = require('path');
const filePath = path.join(__dirname, 'src', 'dashboard', 'index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

const OLD = '<option value="active">Active</option>';
const NEW = '<option value="active" selected>Active</option>';
if (!content.includes(OLD)) { console.error('ERROR: anchor not found'); process.exit(1); }
content = content.replace(OLD, NEW);
console.log('✓ Active set as default');

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('✓ Written');
