// _fix_sims_1000cap.js
// Fix: handleSims was using supabaseGet with &limit=5000 (PostgREST ignores anything over 1000).
// Switch to supabaseGetAllArray so all SIMs are fetched regardless of count.
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');

content = content.replace(/\r\n/g, '\n');

const OLD = `    let query = \`sims?select=id,iccid,port,status,vendor,carrier,rotation_interval_hours,rotation_eligible,mobility_subscription_id,gateway_id,last_mdn_rotated_at,activated_at,last_activation_error,last_notified_at,gateways(code,name),sim_numbers(e164,verification_status),reseller_sims(reseller_id,resellers(name))&sim_numbers.valid_to=is.null&reseller_sims.active=eq.true&order=id.desc&limit=5000\`;

    // Apply status filter
    if (statusFilter) {
      query += \`&status=eq.\${statusFilter}\`;
    } else if (hideCancelled) {
      query += \`&status=neq.canceled\`;
    }

    const response = await supabaseGet(env, query);
    const sims = await response.json();`;

const NEW = `    let query = \`sims?select=id,iccid,port,status,vendor,carrier,rotation_interval_hours,rotation_eligible,mobility_subscription_id,gateway_id,last_mdn_rotated_at,activated_at,last_activation_error,last_notified_at,gateways(code,name),sim_numbers(e164,verification_status),reseller_sims(reseller_id,resellers(name))&sim_numbers.valid_to=is.null&reseller_sims.active=eq.true&order=id.desc\`;

    // Apply status filter
    if (statusFilter) {
      query += \`&status=eq.\${statusFilter}\`;
    } else if (hideCancelled) {
      query += \`&status=neq.canceled\`;
    }

    const sims = await supabaseGetAllArray(env, query);`;

if (!content.includes(OLD)) {
  console.error('PATCH FAILED: old string not found. File may have changed.');
  process.exit(1);
}

content = content.replace(OLD, NEW);

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch applied successfully.');
