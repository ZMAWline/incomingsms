// Add carrier_api_logs logging to handleHelixQuery
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');

content = content.replace(/\r\n/g, '\n');

const OLD = `    const data = Array.isArray(detailsData) ? detailsData[0] : detailsData;
    let db_update = null;
    if (data && (data.status === 'CANCELLED' || data.status === 'CANCELED')) {
      db_update = await syncCancelledSim(env, String(subId), data);
    }

    return new Response(JSON.stringify({ ok: true, mobility_subscription_id: subId, helix_response: detailsData, db_update }, null, 2), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });`;

const NEW = `    const data = Array.isArray(detailsData) ? detailsData[0] : detailsData;
    let db_update = null;
    if (data && (data.status === 'CANCELLED' || data.status === 'CANCELED')) {
      db_update = await syncCancelledSim(env, String(subId), data);
    }

    // Log to carrier_api_logs
    await logCarrierApiCall(env, {
      run_id: 'helix_query_' + subId + '_' + Date.now(),
      step: 'query',
      iccid: data?.iccid || null,
      imei: data?.imei || null,
      vendor: 'helix',
      request_url: detailsUrl,
      request_method: 'POST',
      request_body: { mobilitySubscriptionId: parseInt(subId) },
      response_status: detailsRes.status,
      response_ok: detailsRes.ok,
      response_body_text: detailsText,
      response_body_json: detailsData,
      error: null,
    });

    return new Response(JSON.stringify({ ok: true, mobility_subscription_id: subId, helix_response: detailsData, db_update }, null, 2), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });`;

if (!content.includes(OLD)) {
  console.error('PATCH FAILED: old pattern not found');
  process.exit(1);
}
content = content.replace(OLD, NEW);

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch applied: Helix queries now logged to carrier_api_logs');
