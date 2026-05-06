const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

const OLD = `          await sbPatch(env, 'sims?iccid=eq.' + encodeURIComponent(iccid), {
            rotation_status: 'failed',
            status: 'provisioning',
            last_rotation_error: 'Stuck on ABIR plan — flagged by Query at ' + new Date().toISOString(),
          });`;

const NEW = `          await sbPatch(env, 'sims?iccid=eq.' + encodeURIComponent(iccid), {
            rotation_status: 'failed',
            status: 'rotation_failed',
            last_rotation_error: 'Stuck on ABIR plan — flagged by Query at ' + new Date().toISOString(),
          });`;

if (!content.includes(OLD)) {
  console.error('PATCH FAILED: old string not found.');
  process.exit(1);
}
content = content.replace(OLD, NEW);
content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch applied.');
