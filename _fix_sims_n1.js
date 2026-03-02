const fs = require('fs');

const file = 'src/dashboard/index.js';
let content = fs.readFileSync(file, 'utf8');

// Normalize to LF for searching
const normalized = content.replace(/\r\n/g, '\n');

const OLD = `    const formatted = await Promise.all(filteredSims.map(async sim => {
      // Get SMS count and last received timestamp
      const smsQuery = \`inbound_sms?select=id,received_at&sim_id=eq.\${sim.id}&order=received_at.desc&limit=1\`;
      const smsResponse = await supabaseGet(env, smsQuery);
      const smsData = await smsResponse.json();

      // Get total count
      const countQuery = \`inbound_sms?select=id&sim_id=eq.\${sim.id}\`;
      const countResponse = await fetch(\`\${env.SUPABASE_URL}/rest/v1/\${countQuery}\`, {
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: \`Bearer \${env.SUPABASE_SERVICE_ROLE_KEY}\`,
          Accept: 'application/json',
          Prefer: 'count=exact'
        }
      });

      const countHeader = countResponse.headers.get('content-range');
      const smsCount = countHeader ? parseInt(countHeader.split('/')[1]) : 0;
      const lastReceived = smsData.length > 0 ? smsData[0].received_at : null;

      // Extract reseller info
      const resellerSim = sim.reseller_sims?.[0];
      const resellerId = resellerSim?.reseller_id || null;
      const resellerName = resellerSim?.resellers?.name || null;

      return {
        id: sim.id,
        iccid: sim.iccid,
        port: sim.port,
        status: sim.status,
        mobility_subscription_id: sim.mobility_subscription_id,
        phone_number: sim.sim_numbers?.[0]?.e164 || null,
        verification_status: sim.sim_numbers?.[0]?.verification_status || null,
        sms_count: smsCount,
        last_sms_received: lastReceived,
        reseller_id: resellerId,
        reseller_name: resellerName,
        gateway_id: sim.gateway_id,
        gateway_code: sim.gateways?.code || null,
        gateway_name: sim.gateways?.name || null,
        last_mdn_rotated_at: sim.last_mdn_rotated_at || null,
        last_activation_error: sim.last_activation_error || null,
      };
    }));`;

const NEW = `    // Batch SMS stats: one query for all sim IDs to avoid N+1 queries
    const simIds = filteredSims.map(s => s.id);
    const smsMap = {}; // sim_id -> { count, last_received }
    if (simIds.length > 0) {
      const batchUrl = env.SUPABASE_URL + '/rest/v1/inbound_sms?select=sim_id,received_at&sim_id=in.(' + simIds.join(',') + ')&order=sim_id,received_at.desc&limit=5000';
      const batchResp = await fetch(batchUrl, {
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
          Accept: 'application/json',
        }
      });
      const batchRows = await batchResp.json();
      for (const row of batchRows) {
        if (!smsMap[row.sim_id]) {
          smsMap[row.sim_id] = { count: 0, last_received: null };
        }
        smsMap[row.sim_id].count++;
        if (!smsMap[row.sim_id].last_received) {
          smsMap[row.sim_id].last_received = row.received_at;
        }
      }
    }

    const formatted = filteredSims.map(sim => {
      const smsStat = smsMap[sim.id] || { count: 0, last_received: null };

      // Extract reseller info
      const resellerSim = sim.reseller_sims?.[0];
      const resellerId = resellerSim?.reseller_id || null;
      const resellerName = resellerSim?.resellers?.name || null;

      return {
        id: sim.id,
        iccid: sim.iccid,
        port: sim.port,
        status: sim.status,
        mobility_subscription_id: sim.mobility_subscription_id,
        phone_number: sim.sim_numbers?.[0]?.e164 || null,
        verification_status: sim.sim_numbers?.[0]?.verification_status || null,
        sms_count: smsStat.count,
        last_sms_received: smsStat.last_received,
        reseller_id: resellerId,
        reseller_name: resellerName,
        gateway_id: sim.gateway_id,
        gateway_code: sim.gateways?.code || null,
        gateway_name: sim.gateways?.name || null,
        last_mdn_rotated_at: sim.last_mdn_rotated_at || null,
        activated_at: sim.activated_at || null,
        last_activation_error: sim.last_activation_error || null,
      };
    });`;

if (!normalized.includes(OLD)) {
  console.error('ERROR: old string not found!');
  process.exit(1);
}

const patched = normalized.replace(OLD, NEW);

// Convert back to CRLF
const result = patched.replace(/\n/g, '\r\n');
fs.writeFileSync(file, result);
console.log('Patched successfully');
