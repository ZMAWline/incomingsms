// Add a plan guardrail to handleWingCheck so the dashboard Query button does
// not mark a wing_iot SIM 'active' while AT&T still has it on the non-dialable
// ABIR plan. Surface a db_skip_reason in the response so the UI can warn.

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

const OLD =
`    let db_update_wing = null;
    const wingStatus = json && json.status ? json.status.toLowerCase() : '';
    if (res.ok && json && (wingStatus === 'active' || wingStatus === 'activated')) {
      db_update_wing = await syncActiveSim(env, iccid, {
        mdn: json.mdn || json.msisdn || null,
        activatedAt: json.dateActivated || null,
      });
    }
    return new Response(JSON.stringify({
      ok: res.ok,
      status: res.status,
      iccid,
      response: json || text,
      db_update: db_update_wing,
    }, null, 2), {`;

const NEW =
`    let db_update_wing = null;
    let db_skip_reason = null;
    const wingStatus = json && json.status ? json.status.toLowerCase() : '';
    const wingPlan = json && json.communicationPlan ? json.communicationPlan : '';
    const DIALABLE_PLAN = 'Wing Tel Inc - NON ABIR SMS MO/MT US';
    if (res.ok && json && (wingStatus === 'active' || wingStatus === 'activated')) {
      if (wingPlan === DIALABLE_PLAN) {
        db_update_wing = await syncActiveSim(env, iccid, {
          mdn: json.mdn || json.msisdn || null,
          activatedAt: json.dateActivated || null,
        });
      } else {
        db_skip_reason = 'SIM is on plan "' + wingPlan + '" (not the dialable NON ABIR plan). DB was NOT synced to active because the SIM cannot send/receive normal SMS in this state. Force-rotate to recover.';
      }
    }
    return new Response(JSON.stringify({
      ok: res.ok,
      status: res.status,
      iccid,
      response: json || text,
      db_update: db_update_wing,
      db_skip_reason: db_skip_reason,
    }, null, 2), {`;

if (!content.includes(OLD)) {
  console.error('PATCH FAILED: old string not found.');
  process.exit(1);
}
content = content.replace(OLD, NEW);

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch applied successfully.');
