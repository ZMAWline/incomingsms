// When dashboard Wing IoT Query detects the SIM on the non-dialable ABIR plan,
// flip sims.rotation_status='failed' so mdn-rotator's remediation pass picks it
// up and retries the dialable PUT.

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

const OLD =
`      } else {
        db_skip_reason = 'SIM is on plan "' + wingPlan + '" (not the dialable NON ABIR plan). DB was NOT synced to active because the SIM cannot send/receive normal SMS in this state. Force-rotate to recover.';
      }`;

const NEW =
`      } else {
        // SIM is on ABIR (non-dialable). Flag rotation_status='failed' so the
        // mdn-rotator's remediation pass on the next /run will pick it up and
        // run the dialable PUT (jumps straight to PUT-2 via the "already on
        // ABIR" path in rotateWingIotSim).
        try {
          await sbPatch(env, 'sims?iccid=eq.' + encodeURIComponent(iccid), {
            rotation_status: 'failed',
            last_rotation_error: 'Stuck on ABIR plan — flagged by Query at ' + new Date().toISOString(),
          });
          db_skip_reason = 'SIM is on plan "' + wingPlan + '" (not dialable). Marked rotation_status=failed — run mdn-rotator to retry the dialable PUT.';
        } catch (e) {
          db_skip_reason = 'SIM is on plan "' + wingPlan + '" (not dialable). Failed to flag for retry: ' + String(e);
        }
      }`;

if (!content.includes(OLD)) {
  console.error('PATCH FAILED: old string not found.');
  process.exit(1);
}
content = content.replace(OLD, NEW);

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch applied successfully.');
