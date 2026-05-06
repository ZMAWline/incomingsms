// _fix_wing_status_mdn.js
// Wing IoT returns status="ACTIVATED" (not "ACTIVE") and mdn field is "msisdn"
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

// 1. Backend: fix status check (ACTIVATED) and mdn field (msisdn), add dateActivated
const OLD1 =
`    if (res.ok && json && json.status && json.status.toLowerCase() === 'active') {
      db_update_wing = await syncActiveSim(env, iccid, { mdn: json.mdn || null, activatedAt: null });
    }`;
const NEW1 =
`    const wingStatus = json && json.status ? json.status.toLowerCase() : '';
    if (res.ok && json && (wingStatus === 'active' || wingStatus === 'activated')) {
      db_update_wing = await syncActiveSim(env, iccid, {
        mdn: json.mdn || json.msisdn || null,
        activatedAt: json.dateActivated || null,
      });
    }`;
if (!content.includes(OLD1)) { console.error('PATCH FAILED: OLD1 not found'); process.exit(1); }
content = content.replace(OLD1, NEW1);
console.log('1. backend wing status+mdn fixed');

// 2. Frontend modal display: show msisdn fallback for mdn field
const OLD2 = `                        formatted += '<span class="text-blue-400">mdn:</span> ' + (data.mdn || 'N/A') + '\\\\n';`;
const NEW2 = `                        formatted += '<span class="text-blue-400">mdn:</span> ' + (data.mdn || data.msisdn || 'N/A') + '\\\\n';`;
if (!content.includes(OLD2)) { console.error('PATCH FAILED: OLD2 not found'); process.exit(1); }
content = content.replace(OLD2, NEW2);
console.log('2. frontend mdn display fixed');

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Done.');
