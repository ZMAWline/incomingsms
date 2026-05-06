const fs = require('fs'), path = require('path');
const filePath = path.join(__dirname, 'src', 'dashboard', 'index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

const OLD = 'inbound_sms?select=id,to_number,from_number,body,received_at,sim_id,sims(iccid)&order=received_at.desc&limit=50';
const NEW = 'inbound_sms?select=id,to_number,from_number,body,received_at,sim_id,sims(iccid)&order=received_at.desc&limit=500';
if (!content.includes(OLD)) { console.error('ERROR: anchor not found'); process.exit(1); }
content = content.replace(OLD, NEW);
console.log('✓ Messages limit raised to 500');

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('✓ Written');
