const fs = require('fs');
const path = require('path');
const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');
const OLD = "    const _dbg = {\n      teltik_sim_ids:";
const NEW = "    const _dbg = {\n      rs_sims_returned: Array.isArray(rsSims) ? rsSims.length : null,\n      teltik_sim_ids:";
if (!content.includes(OLD)) { console.error('anchor not found'); process.exit(1); }
content = content.replace(OLD, NEW);
content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('added rs_sims_returned');
