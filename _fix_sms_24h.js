const fs = require('fs');

const file = 'src/dashboard/index.js';
let content = fs.readFileSync(file, 'utf8');
const normalized = content.replace(/\r\n/g, '\n');

const OLD =
    `      const idList = simIds.join(',');\n` +
    `      const smsBaseUrl = env.SUPABASE_URL + '/rest/v1/inbound_sms?select=sim_id,received_at&sim_id=in.(' + idList + ')&order=sim_id,received_at.desc';\n` +
    `      const smsHeaders = {\n` +
    `        apikey: env.SUPABASE_SERVICE_ROLE_KEY,\n` +
    `        Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,\n` +
    `        Accept: 'application/json',\n` +
    `        Prefer: 'count=exact',\n` +
    `      };\n` +
    `      // First page — also gets total count\n` +
    `      const firstResp = await fetch(smsBaseUrl + '&limit=1000&offset=0', { headers: smsHeaders });\n` +
    `      const contentRange = firstResp.headers.get('content-range'); // e.g. "0-999/8391"\n` +
    `      const smsTotal = contentRange ? parseInt(contentRange.split('/')[1]) || 0 : 0;\n` +
    `      const allPages = [await firstResp.json()];\n` +
    `      // Fetch remaining pages in parallel\n` +
    `      if (smsTotal > 1000) {\n` +
    `        const extraFetches = [];\n` +
    `        for (let offset = 1000; offset < smsTotal; offset += 1000) {\n` +
    `          extraFetches.push(fetch(smsBaseUrl + '&limit=1000&offset=' + offset, { headers: smsHeaders }).then(r => r.json()));\n` +
    `        }\n` +
    `        const extraPages = await Promise.all(extraFetches);\n` +
    `        allPages.push(...extraPages);\n` +
    `      }\n` +
    `      // Aggregate: rows are ordered desc per sim_id so first occurrence = latest\n` +
    `      for (const page of allPages) {\n` +
    `        for (const row of page) {\n` +
    `          if (!smsMap[row.sim_id]) {\n` +
    `            smsMap[row.sim_id] = { count: 0, last_received: row.received_at };\n` +
    `          }\n` +
    `          smsMap[row.sim_id].count++;\n` +
    `        }\n` +
    `      }\n` +
    `    }`;

const NEW =
    `      const idList = simIds.join(',');\n` +
    `      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();\n` +
    `      const smsUrl = env.SUPABASE_URL + '/rest/v1/inbound_sms?select=sim_id,received_at&sim_id=in.(' + idList + ')&received_at=gte.' + since + '&order=sim_id,received_at.desc&limit=1000';\n` +
    `      const smsResp = await fetch(smsUrl, {\n` +
    `        headers: {\n` +
    `          apikey: env.SUPABASE_SERVICE_ROLE_KEY,\n` +
    `          Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,\n` +
    `          Accept: 'application/json',\n` +
    `        }\n` +
    `      });\n` +
    `      const smsRows = await smsResp.json();\n` +
    `      for (const row of smsRows) {\n` +
    `        if (!smsMap[row.sim_id]) {\n` +
    `          smsMap[row.sim_id] = { count: 0, last_received: row.received_at };\n` +
    `        }\n` +
    `        smsMap[row.sim_id].count++;\n` +
    `      }\n` +
    `    }`;

if (!normalized.includes(OLD)) {
  console.error('ERROR: old string not found');
  process.exit(1);
}

const result = normalized.replace(OLD, NEW).replace(/\n/g, '\r\n');
fs.writeFileSync(file, result);
console.log('Patched');
