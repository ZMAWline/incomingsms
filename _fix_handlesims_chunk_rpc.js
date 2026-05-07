const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

// Replace the single-RPC-call block (with our debug logs) with a chunked
// parallel-fetch implementation. Each chunk is bounded to 500 IDs so the
// PostgREST 1000-row cap can never truncate a single response — regardless
// of how many SIMs exist now or in the future.
const OLD = `    // Get SMS stats via DB-side aggregation (avoids row-limit truncation)
    const simIds = filteredSims.map(s => s.id);
    const smsMap = {}; // sim_id -> { count, last_received }
    if (simIds.length > 0) {
      const smsUrl = env.SUPABASE_URL + '/rest/v1/rpc/get_sms_counts_24h';
      const smsResp = await fetch(smsUrl, {
        method: 'POST',
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ sim_ids: simIds }),
      });
      const smsRows = await smsResp.json();
      const sim2634InRequest = simIds.includes(2634);
      const sim2634InResponse = Array.isArray(smsRows) && smsRows.some(r => Number(r.sim_id) === 2634);
      const rpcSummary = Array.isArray(smsRows) ? ('rows=' + smsRows.length) : ('NOT_ARRAY:' + JSON.stringify(smsRows).slice(0, 200));
      console.log('[handleSims-debug] simIds.length=' + simIds.length + ' includes2634=' + sim2634InRequest + ' rpc=' + rpcSummary + ' rpcIncludes2634=' + sim2634InResponse);
      for (const row of smsRows) {
        smsMap[row.sim_id] = { count: Number(row.sms_count), last_received: row.last_received };
      }
      console.log('[handleSims-debug] smsMap.size=' + Object.keys(smsMap).length + ' has2634num=' + (smsMap[2634] !== undefined) + ' has2634str=' + (smsMap['2634'] !== undefined) + ' sample2634=' + JSON.stringify(smsMap[2634] || smsMap['2634'] || null));
    }`;

const NEW = `    // Get SMS stats via DB-side aggregation, chunked into batches of 500
    // sim_ids per RPC call. PostgREST caps response rows at 1000, so a single
    // call with all sim_ids silently truncates once >1000 SIMs have messages.
    const simIds = filteredSims.map(s => s.id);
    const smsMap = {}; // sim_id -> { count, last_received }
    if (simIds.length > 0) {
      const CHUNK = 500;
      const chunks = [];
      for (let i = 0; i < simIds.length; i += CHUNK) chunks.push(simIds.slice(i, i + CHUNK));
      const smsUrl = env.SUPABASE_URL + '/rest/v1/rpc/get_sms_counts_24h';
      const rpcHeaders = {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };
      const responses = await Promise.all(chunks.map(chunk =>
        fetch(smsUrl, {
          method: 'POST',
          headers: rpcHeaders,
          body: JSON.stringify({ sim_ids: chunk }),
        }).then(r => r.json())
      ));
      for (const rows of responses) {
        if (!Array.isArray(rows)) continue;
        for (const row of rows) {
          smsMap[row.sim_id] = { count: Number(row.sms_count), last_received: row.last_received };
        }
      }
    }`;

if (!content.includes(OLD)) {
  console.error('PATCH FAILED: old string not found.');
  process.exit(1);
}
content = content.replace(OLD, () => NEW);

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch applied.');
