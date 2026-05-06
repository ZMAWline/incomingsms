const fs = require('fs');
const raw = fs.readFileSync('src/dashboard/index.js', 'utf8');
const src = raw.replace(/\r\n/g, '\n');

const OLD = "sbUrl + '/rest/v1/sims?select=id,gateway_id,port,sim_numbers(e164)&status=eq.active&gateway_id=not.is.null&port=not.is.null&sim_numbers.valid_to=is.null&limit=200'";
const NEW = "sbUrl + '/rest/v1/sims?select=id,gateway_id,port,sim_numbers(e164)&status=eq.active&gateway_id=eq.1&port=not.is.null&sim_numbers.valid_to=is.null&limit=200'";

if (!src.includes(OLD)) { console.log('[FAIL] pattern not found'); process.exit(1); }
const out = src.replace(OLD, NEW);
fs.writeFileSync('src/dashboard/index.js', out.replace(/\n/g, '\r\n'));
console.log('[OK] sender pool restricted to gateway_id=1 (64-port)');
