const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

// Change plain INSERT to UPSERT so existing (inactive) rows are updated instead of 409-ing
const OLD =
  '    // Insert new assignment\n' +
  '    const res = await fetch(' + '`' + '${env.SUPABASE_URL}/rest/v1/reseller_sims' + '`' + ', {\n' +
  "      method: 'POST',\n" +
  '      headers: {\n' +
  "        apikey: env.SUPABASE_SERVICE_ROLE_KEY,\n" +
  '        Authorization: ' + '`' + 'Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}' + '`' + ',\n' +
  "        'Content-Type': 'application/json',\n" +
  "        Prefer: 'return=minimal',\n" +
  '      },\n' +
  '      body: JSON.stringify({ sim_id, reseller_id, active: true }),\n' +
  '    });';

const NEW =
  '    // Upsert new assignment (handles existing inactive row from prior assignment)\n' +
  '    const res = await fetch(' + '`' + '${env.SUPABASE_URL}/rest/v1/reseller_sims?on_conflict=reseller_id,sim_id' + '`' + ', {\n' +
  "      method: 'POST',\n" +
  '      headers: {\n' +
  "        apikey: env.SUPABASE_SERVICE_ROLE_KEY,\n" +
  '        Authorization: ' + '`' + 'Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}' + '`' + ',\n' +
  "        'Content-Type': 'application/json',\n" +
  "        Prefer: 'resolution=merge-duplicates,return=minimal',\n" +
  '      },\n' +
  '      body: JSON.stringify({ sim_id, reseller_id, active: true }),\n' +
  '    });';

if (!content.includes(OLD)) throw new Error('OLD not found');
content = content.replace(OLD, NEW);
console.log('Upsert applied');

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Done!');
