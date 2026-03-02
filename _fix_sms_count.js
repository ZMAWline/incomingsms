const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');

// Normalize to LF for searching
const lf = content.replace(/\r\n/g, '\n');

const OLD =
  '    // Get SMS stats for each SIM\n' +
  '    // Batch SMS stats: paginate (PostgREST caps at 1000 rows/request)\n' +
  '    const simIds = filteredSims.map(s => s.id);\n' +
  '    const smsMap = {}; // sim_id -> { count, last_received }\n' +
  '    if (simIds.length > 0) {\n' +
  '      const idList = simIds.join(\',\');\n' +
  '      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();\n' +
  '      const smsUrl = env.SUPABASE_URL + \'/rest/v1/inbound_sms?select=sim_id,received_at&sim_id=in.(\' + idList + \')&received_at=gte.\' + since + \'&order=sim_id,received_at.desc&limit=1000\';\n' +
  '      const smsResp = await fetch(smsUrl, {\n' +
  '        headers: {\n' +
  '          apikey: env.SUPABASE_SERVICE_ROLE_KEY,\n' +
  '          Authorization: \'Bearer \' + env.SUPABASE_SERVICE_ROLE_KEY,\n' +
  '          Accept: \'application/json\',\n' +
  '        }\n' +
  '      });\n' +
  '      const smsRows = await smsResp.json();\n' +
  '      for (const row of smsRows) {\n' +
  '        if (!smsMap[row.sim_id]) {\n' +
  '          smsMap[row.sim_id] = { count: 0, last_received: row.received_at };\n' +
  '        }\n' +
  '        smsMap[row.sim_id].count++;\n' +
  '      }\n' +
  '    }';

const NEW =
  '    // Get SMS stats via DB-side aggregation (avoids row-limit truncation)\n' +
  '    const simIds = filteredSims.map(s => s.id);\n' +
  '    const smsMap = {}; // sim_id -> { count, last_received }\n' +
  '    if (simIds.length > 0) {\n' +
  '      const smsUrl = env.SUPABASE_URL + \'/rest/v1/rpc/get_sms_counts_24h\';\n' +
  '      const smsResp = await fetch(smsUrl, {\n' +
  '        method: \'POST\',\n' +
  '        headers: {\n' +
  '          apikey: env.SUPABASE_SERVICE_ROLE_KEY,\n' +
  '          Authorization: \'Bearer \' + env.SUPABASE_SERVICE_ROLE_KEY,\n' +
  '          \'Content-Type\': \'application/json\',\n' +
  '          Accept: \'application/json\',\n' +
  '        },\n' +
  '        body: JSON.stringify({ sim_ids: simIds }),\n' +
  '      });\n' +
  '      const smsRows = await smsResp.json();\n' +
  '      for (const row of smsRows) {\n' +
  '        smsMap[row.sim_id] = { count: Number(row.sms_count), last_received: row.last_received };\n' +
  '      }\n' +
  '    }';

if (!lf.includes(OLD)) {
  console.error('ERROR: Could not find the target block. Dumping first 400 chars of search area...');
  const idx = lf.indexOf('    // Get SMS stats for each SIM');
  if (idx !== -1) {
    console.error('Found comment at idx', idx);
    console.error(JSON.stringify(lf.slice(idx, idx + 600)));
  }
  process.exit(1);
}

const patched = lf.replace(OLD, NEW);
const result = patched.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, result, 'utf8');
console.log('Patched successfully.');
