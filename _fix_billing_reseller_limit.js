// _fix_billing_reseller_limit.js
// Add &limit=5000 to the two reseller_sims billing queries so large resellers
// (e.g. TrustOTP with 1213 active SIMs) aren't silently truncated by
// PostgREST's 1000-row default.
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');

content = content.replace(/\r\n/g, '\n');

const OLD =
  "    const smsResp = await supabaseGet(env,\n" +
  "      'reseller_sims?select=sim_id,sims(vendor,sim_sms_daily(est_date,sms_count))' +\n" +
  "      '&reseller_id=eq.' + encodeURIComponent(resellerId) +\n" +
  "      '&active=eq.true'\n" +
  "    );";

const NEW =
  "    const smsResp = await supabaseGet(env,\n" +
  "      'reseller_sims?select=sim_id,sims(vendor,sim_sms_daily(est_date,sms_count))' +\n" +
  "      '&reseller_id=eq.' + encodeURIComponent(resellerId) +\n" +
  "      '&active=eq.true' +\n" +
  "      '&limit=5000'\n" +
  "    );";

const occurrences = content.split(OLD).length - 1;
if (occurrences !== 2) {
  console.error('PATCH FAILED: expected 2 occurrences of OLD, found ' + occurrences);
  process.exit(1);
}

content = content.split(OLD).join(NEW);

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch applied: 2 reseller_sims queries updated with &limit=5000.');
