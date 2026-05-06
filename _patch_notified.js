const fs = require('fs');
const raw = fs.readFileSync('src/dashboard/index.js', 'utf8');
const src = raw.replace(/\r\n/g, '\n');

let out = src;

// 1. Add last_notified_at to sims select query
out = out.replace(
  'sims?select=id,iccid,port,status,mobility_subscription_id,gateway_id,last_mdn_rotated_at,activated_at,last_activation_error,gateways(code,name),sim_numbers(e164,verification_status),reseller_sims(reseller_id,resellers(name))&sim_numbers.valid_to=is.null&reseller_sims.active=eq.true&order=id.desc&limit=5000',
  'sims?select=id,iccid,port,status,mobility_subscription_id,gateway_id,last_mdn_rotated_at,activated_at,last_activation_error,last_notified_at,gateways(code,name),sim_numbers(e164,verification_status),reseller_sims(reseller_id,resellers(name))&sim_numbers.valid_to=is.null&reseller_sims.active=eq.true&order=id.desc&limit=5000'
);

// 2. Add last_notified_at to data mapping
out = out.replace(
  'last_activation_error: sim.last_activation_error || null,\n      };',
  'last_activation_error: sim.last_activation_error || null,\n        last_notified_at: sim.last_notified_at || null,\n      };'
);

// 3. Add last_notified_at to DATE_FIELDS
out = out.replace(
  "CONST DATE_FIELDS = ['activated_at','last_sms_received','last_mdn_rotated_at','created_at','updated_at']",
  "CONST DATE_FIELDS = ['activated_at','last_sms_received','last_mdn_rotated_at','last_notified_at','created_at','updated_at']"
);
// Also try lowercase variant
out = out.replace(
  "const DATE_FIELDS = ['activated_at','last_sms_received','last_mdn_rotated_at','created_at','updated_at']",
  "const DATE_FIELDS = ['activated_at','last_sms_received','last_mdn_rotated_at','last_notified_at','created_at','updated_at']"
);

// 4. Add table header after Activated column
out = out.replace(
  'onclick="sortTable(\'sims\',\'activated_at\')">Activated <span class="sort-arrow" data-table="sims" data-col="activated_at"></span></th>\n                                    <th class="px-4 py-3 font-medium">Actions</th>',
  'onclick="sortTable(\'sims\',\'activated_at\')">Activated <span class="sort-arrow" data-table="sims" data-col="activated_at"></span></th>\n                                    <th class="px-4 py-3 font-medium cursor-pointer hover:text-gray-300 select-none" onclick="sortTable(\'sims\',\'last_notified_at\')">Last Notified <span class="sort-arrow" data-table="sims" data-col="last_notified_at"></span></th>\n                                    <th class="px-4 py-3 font-medium">Actions</th>'
);

// 5. Add row cell after Activated cell
// The activated_at cell ends before the actions cell
const activatedCell = '<td class="px-4 py-3 text-gray-500 text-xs">\\${sim.activated_at ? new Date(sim.activated_at).toLocaleString() : \'-\'}</td>';
const notifiedCell = '<td class="px-4 py-3 text-gray-500 text-xs">\\${sim.last_notified_at ? new Date(sim.last_notified_at).toLocaleString() : \'-\'}</td>';
out = out.replace(
  activatedCell + '\n                    <td class="px-4 py-3 whitespace-nowrap">',
  activatedCell + '\n                    ' + notifiedCell + '\n                    <td class="px-4 py-3 whitespace-nowrap">'
);

// 6. In handleSimOnline: after recording delivery to webhook_deliveries when ok,
//    also PATCH sims.last_notified_at
// Find the "if (webhookOk)" return block and add the PATCH before the return
const patchSql = `
    // Update last_notified_at on the SIM
    if (webhookOk) {
      await fetch(env.SUPABASE_URL + '/rest/v1/sims?id=eq.' + simId, {
        method: 'PATCH',
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ last_notified_at: new Date().toISOString() }),
      });
    }`;

// Insert after the webhook_deliveries insert block, before the "if (webhookOk) {" return block
const deliveryInsertEnd = `    });

    if (webhookOk) {
      return new Response(JSON.stringify({
        ok: true,
        message: \`Successfully sent number.online webhook for \${currentNumber}\``;

const deliveryInsertEndReplacement = `    });
` + patchSql + `

    if (webhookOk) {
      return new Response(JSON.stringify({
        ok: true,
        message: \`Successfully sent number.online webhook for \${currentNumber}\``;

out = out.replace(deliveryInsertEnd, deliveryInsertEndReplacement);

// Write back with CRLF
fs.writeFileSync('src/dashboard/index.js', out.replace(/\n/g, '\r\n'));
console.log('Patch applied.');

// Verify key replacements
const verify = out;
if (verify.includes('last_notified_at,gateways')) console.log('[OK] sims query updated');
else console.log('[FAIL] sims query NOT updated');

if (verify.includes('last_notified_at: sim.last_notified_at')) console.log('[OK] data mapping updated');
else console.log('[FAIL] data mapping NOT updated');

if (verify.includes("'last_notified_at'")) console.log('[OK] DATE_FIELDS updated');
else console.log('[FAIL] DATE_FIELDS NOT updated');

if (verify.includes('Last Notified')) console.log('[OK] table header added');
else console.log('[FAIL] table header NOT added');

if (verify.includes('sim.last_notified_at ? new Date(sim.last_notified_at)')) console.log('[OK] row cell added');
else console.log('[FAIL] row cell NOT added');

if (verify.includes('last_notified_at: new Date().toISOString()')) console.log('[OK] handleSimOnline PATCH added');
else console.log('[FAIL] handleSimOnline PATCH NOT added');
