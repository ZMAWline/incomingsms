const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

// Add three diagnostic log lines around the RPC call in handleSims so we can
// tail wrangler and answer: where do the 28 gateway-1 SIMs (2607-2634) drop
// off — sims fetch, RPC response, or smsMap lookup?
const OLD = `      const smsRows = await smsResp.json();
      for (const row of smsRows) {
        smsMap[row.sim_id] = { count: Number(row.sms_count), last_received: row.last_received };
      }
    }`;

const NEW = `      const smsRows = await smsResp.json();
      const sim2634InRequest = simIds.includes(2634);
      const sim2634InResponse = Array.isArray(smsRows) && smsRows.some(r => Number(r.sim_id) === 2634);
      const rpcSummary = Array.isArray(smsRows) ? ('rows=' + smsRows.length) : ('NOT_ARRAY:' + JSON.stringify(smsRows).slice(0, 200));
      console.log('[handleSims-debug] simIds.length=' + simIds.length + ' includes2634=' + sim2634InRequest + ' rpc=' + rpcSummary + ' rpcIncludes2634=' + sim2634InResponse);
      for (const row of smsRows) {
        smsMap[row.sim_id] = { count: Number(row.sms_count), last_received: row.last_received };
      }
      console.log('[handleSims-debug] smsMap.size=' + Object.keys(smsMap).length + ' has2634num=' + (smsMap[2634] !== undefined) + ' has2634str=' + (smsMap['2634'] !== undefined) + ' sample2634=' + JSON.stringify(smsMap[2634] || smsMap['2634'] || null));
    }`;

if (!content.includes(OLD)) {
  console.error('PATCH FAILED: old string not found.');
  process.exit(1);
}
content = content.replace(OLD, () => NEW);

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch applied.');
