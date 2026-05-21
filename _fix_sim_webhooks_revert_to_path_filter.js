// _fix_sim_webhooks_revert_to_path_filter.js
// Revert handleSimWebhooks back to PostgREST JSON-path filter.
// The `cs.{json}` containment filter silently returns 0 rows through PostgREST
// even when matching rows exist (verified via SQL — SIM 719 has 3+ rows,
// SIM 3576 has 9; deployed /api/sim-webhooks returns count:0 for both).
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

const OLD =
  '    // webhook_deliveries.payload is jsonb shaped like { data: { sim_id, iccid, number, ... } }\n' +
  '    // PostgREST supports nested JSON path filtering: payload->data->>sim_id=eq.<id>\n' +
  "    // `cs` = 'contains' — matches any row whose payload jsonb contains the given\n" +
  '    // subobject. More robust than json-path filtering through PostgREST URL parsing.\n' +
  '    const jsonFilter = encodeURIComponent(JSON.stringify({ data: { sim_id: simId } }));\n' +
  '    const q = `webhook_deliveries?select=id,event_type,reseller_id,webhook_url,payload,status,attempts,last_attempt_at,delivered_at,created_at,response_body&event_type=eq.number.online&payload=cs.${jsonFilter}&order=created_at.desc&limit=50`;';

const NEW =
  '    // webhook_deliveries.payload is jsonb shaped like { data: { sim_id, iccid, number, ... } }\n' +
  '    // Use PostgREST nested JSON path filter. The `cs.{json}` containment form\n' +
  '    // (previously tried) silently returned 0 rows here, even though the\n' +
  '    // equivalent SQL `payload @> jsonb` matches — see /api/sim-webhooks 2026-05-21.\n' +
  '    const q = `webhook_deliveries?select=id,event_type,reseller_id,webhook_url,payload,status,attempts,last_attempt_at,delivered_at,created_at,response_body&event_type=eq.number.online&payload->data->>sim_id=eq.${simId}&order=created_at.desc&limit=50`;';

if (!content.includes(OLD)) {
  console.error('PATCH FAILED: old block not found. File may have changed.');
  process.exit(1);
}
content = content.replace(OLD, NEW);

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patched: handleSimWebhooks now uses payload->data->>sim_id=eq.<id>');
