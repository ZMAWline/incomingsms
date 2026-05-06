// _fix_sim_webhooks_filter.js — swap the JSON-path filter for a `cs` (contains)
// operator with explicit URL encoding, which is the robust way to filter on
// nested jsonb via PostgREST.

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

const OLD =
  "    const q = `webhook_deliveries?select=id,event_type,reseller_id,webhook_url,payload,status,attempts,last_attempt_at,delivered_at,created_at,response_body&event_type=eq.number.online&payload->data->>sim_id=eq.${simId}&order=created_at.desc&limit=50`;\n" +
  "    const res = await supabaseGet(env, q);";

const NEW =
  "    // `cs` = 'contains' — matches any row whose payload jsonb contains the given\n" +
  "    // subobject. More robust than json-path filtering through PostgREST URL parsing.\n" +
  "    const jsonFilter = encodeURIComponent(JSON.stringify({ data: { sim_id: simId } }));\n" +
  "    const q = `webhook_deliveries?select=id,event_type,reseller_id,webhook_url,payload,status,attempts,last_attempt_at,delivered_at,created_at,response_body&event_type=eq.number.online&payload=cs.${jsonFilter}&order=created_at.desc&limit=50`;\n" +
  "    const res = await supabaseGet(env, q);";

if (!content.includes(OLD)) {
  console.error('PATCH FAILED: query line not found.');
  process.exit(1);
}
content = content.replace(OLD, NEW);

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patched: handleSimWebhooks uses cs operator with encodeURIComponent.');
