// _fix_billing_preview_pagination.js
// Replace supabaseGet(...&limit=50000) for Teltik rotations with supabaseGetAllArray.
// PostgREST silently caps at 1000 rows server-side, undercounting Teltik blocks
// for resellers with >1000 rotations in the billing window (e.g. Trust OTP).
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');

content = content.replace(/\r\n/g, '\n');

const OLD = [
  "      const rotResp = await supabaseGet(env,",
  "        'sim_numbers?select=sim_id,valid_from&sim_id=in.(' + idList + ')' +",
  "        '&valid_from=gte.' + encodeURIComponent(wideStart.toISOString()) +",
  "        '&valid_from=lt.' + encodeURIComponent(wideEnd.toISOString()) +",
  "        '&order=sim_id.asc,valid_from.asc' +",
  "        '&limit=50000'",
  "      );",
  "      const rotations = await rotResp.json();",
].join('\n');

const NEW = [
  "      const rotations = await supabaseGetAllArray(env,",
  "        'sim_numbers?select=sim_id,valid_from&sim_id=in.(' + idList + ')' +",
  "        '&valid_from=gte.' + encodeURIComponent(wideStart.toISOString()) +",
  "        '&valid_from=lt.' + encodeURIComponent(wideEnd.toISOString()) +",
  "        '&order=sim_id.asc,valid_from.asc'",
  "      );",
].join('\n');

if (!content.includes(OLD)) {
  console.error('PATCH FAILED: old string not found. File may have changed.');
  process.exit(1);
}

const occurrences = content.split(OLD).length - 1;
if (occurrences !== 2) {
  console.error('PATCH FAILED: expected exactly 2 occurrences, found ' + occurrences);
  process.exit(1);
}

content = content.split(OLD).join(NEW);
console.log('Replaced ' + occurrences + ' occurrence(s) of buggy supabaseGet rotations query.');

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch applied successfully.');
