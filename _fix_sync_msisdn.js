// _fix_sync_msisdn.js
// Patch syncActiveSim to also update sims.msisdn when MDN is synced.
// This fixes ATOMIC SIMs that end up with msisdn=null in DB (stranded from rotation).

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');

// Normalize to LF for reliable search/replace
content = content.replace(/\r\n/g, '\n');

// --- Change 1: add msisdn to the select query so we can check current value ---
const OLD1 = `const sims = await sbGet(env, 'sims?iccid=eq.' + encodeURIComponent(iccid) + '&select=id,iccid,status,activated_at,activation_zip&limit=1');`;
const NEW1 = `const sims = await sbGet(env, 'sims?iccid=eq.' + encodeURIComponent(iccid) + '&select=id,iccid,status,activated_at,activation_zip,msisdn&limit=1');`;

if (!content.includes(OLD1)) {
  console.error('PATCH 1 FAILED: old select string not found. File may have changed.');
  process.exit(1);
}
content = content.replace(OLD1, NEW1);
console.log('Patch 1 applied: added msisdn to syncActiveSim select');

// --- Change 2: after computing e164, also patch sims.msisdn if it changed ---
const OLD2 = `      const e164 = toE164(mdn);
      if (e164) {
        const existing = await sbGet(env, 'sim_numbers?sim_id=eq.' + sim.id + '&valid_to=is.null&select=e164&limit=1');`;
const NEW2 = `      const e164 = toE164(mdn);
      if (e164) {
        const msisdnBare = String(mdn).replace(/\\D/g, '').replace(/^1(\\d{10})$/, '$1');
        if (msisdnBare && msisdnBare.length === 10 && msisdnBare !== sim.msisdn) {
          await sbPatch(env, 'sims?id=eq.' + sim.id, { msisdn: msisdnBare });
          result.msisdn_updated = true;
          result.msisdn_new = msisdnBare;
        }
        const existing = await sbGet(env, 'sim_numbers?sim_id=eq.' + sim.id + '&valid_to=is.null&select=e164&limit=1');`;

if (!content.includes(OLD2)) {
  console.error('PATCH 2 FAILED: old e164 block not found. File may have changed.');
  process.exit(1);
}
content = content.replace(OLD2, NEW2);
console.log('Patch 2 applied: added msisdn update inside if(e164) block');

// Convert back to CRLF
content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch applied successfully.');
