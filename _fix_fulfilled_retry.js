// Patch: add retryUntilFulfilled helper and use it for cancel, resume, changeImei in fixSim.
// Retries on both HTTP errors AND application-level rejected/failed responses (up to 2 retries, 5s apart).
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src', 'mdn-rotator', 'index.js');
let src = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');

// ── 1. Insert retryUntilFulfilled before the fixSim section ──────────────
const FIXSIM_HEADER = '// ===========================\n// Fix SIM - Cancel → Resume → New IMEI (eligibility + Helix + gateway) → OTA confirm\n// ===========================';
if (!src.includes(FIXSIM_HEADER)) {
  console.error('Cannot find fixSim section header'); process.exit(1);
}

const newHelper =
  '// ===========================\n' +
  '// retryUntilFulfilled - retries Helix calls that return rejected/failed even on HTTP 200\n' +
  '// ===========================\n' +
  'async function retryUntilFulfilled(fn, { attempts = 3, delayMs = 5000, label = \'\' } = {}) {\n' +
  '  let lastErr;\n' +
  '  for (let i = 1; i <= attempts; i++) {\n' +
  '    try {\n' +
  '      const result = await fn();\n' +
  '      // Check for application-level rejection (status-change responses)\n' +
  '      if (result?.rejected?.length > 0) {\n' +
  '        const msg = result.rejected[0]?.message || JSON.stringify(result.rejected);\n' +
  '        lastErr = new Error(`${label} rejected: ${msg}`);\n' +
  '        console.warn(`[retryUntilFulfilled] ${label} attempt ${i}/${attempts} rejected: ${msg}`);\n' +
  '      // Check for application-level failure (change-IMEI responses)\n' +
  '      } else if (result?.failed?.length > 0) {\n' +
  '        const msg = result.failed[0]?.reason || JSON.stringify(result.failed);\n' +
  '        lastErr = new Error(`${label} failed: ${msg}`);\n' +
  '        console.warn(`[retryUntilFulfilled] ${label} attempt ${i}/${attempts} failed: ${msg}`);\n' +
  '      } else {\n' +
  '        return result; // success\n' +
  '      }\n' +
  '    } catch (err) {\n' +
  '      lastErr = err;\n' +
  '      console.warn(`[retryUntilFulfilled] ${label} attempt ${i}/${attempts} threw: ${err}`);\n' +
  '    }\n' +
  '    if (i < attempts) await sleep(delayMs);\n' +
  '  }\n' +
  '  throw lastErr;\n' +
  '}\n\n';

src = src.replace(FIXSIM_HEADER, newHelper + FIXSIM_HEADER);

// ── 2. Replace cancel retryWithBackoff with retryUntilFulfilled ──────────
const OLD_CANCEL =
  '  // Step 1: Cancel\n' +
  '  console.log(`[FixSim] SIM ${iccid}: canceling subscriber ${mdn}`);\n' +
  '  await retryWithBackoff(\n' +
  '    () => hxChangeSubscriberStatus(env, token, {\n' +
  '      mobilitySubscriptionId: subId,\n' +
  '      subscriberNumber: mdn,\n' +
  '      reasonCode: "CAN",\n' +
  '      reasonCodeId: 1,\n' +
  '      subscriberState: "Cancel",\n' +
  '    }, runId, iccid, "fix_cancel"),\n' +
  '    { attempts: 3, label: `cancel ${iccid}` }\n' +
  '  );';

if (!src.includes(OLD_CANCEL)) {
  console.error('Cannot find cancel block'); process.exit(1);
}

const NEW_CANCEL =
  '  // Step 1: Cancel\n' +
  '  console.log(`[FixSim] SIM ${iccid}: canceling subscriber ${mdn}`);\n' +
  '  await retryUntilFulfilled(\n' +
  '    () => hxChangeSubscriberStatus(env, token, {\n' +
  '      mobilitySubscriptionId: subId,\n' +
  '      subscriberNumber: mdn,\n' +
  '      reasonCode: "CAN",\n' +
  '      reasonCodeId: 1,\n' +
  '      subscriberState: "Cancel",\n' +
  '    }, runId, iccid, "fix_cancel"),\n' +
  '    { attempts: 3, delayMs: 5000, label: `cancel ${iccid}` }\n' +
  '  );';

src = src.replace(OLD_CANCEL, NEW_CANCEL);

// ── 3. Replace resume retryWithBackoff with retryUntilFulfilled ──────────
const OLD_RESUME =
  '  // Step 2: Resume On Cancel\n' +
  '  console.log(`[FixSim] SIM ${iccid}: resuming subscriber ${mdn}`);\n' +
  '  await retryWithBackoff(\n' +
  '    () => hxChangeSubscriberStatus(env, token, {\n' +
  '      mobilitySubscriptionId: subId,\n' +
  '      subscriberNumber: mdn,\n' +
  '      reasonCode: "BBL",\n' +
  '      reasonCodeId: 20,\n' +
  '      subscriberState: "Resume On Cancel",\n' +
  '    }, runId, iccid, "fix_resume"),\n' +
  '    { attempts: 3, label: `resume ${iccid}` }\n' +
  '  );';

if (!src.includes(OLD_RESUME)) {
  console.error('Cannot find resume block'); process.exit(1);
}

const NEW_RESUME =
  '  // Step 2: Resume On Cancel\n' +
  '  console.log(`[FixSim] SIM ${iccid}: resuming subscriber ${mdn}`);\n' +
  '  await retryUntilFulfilled(\n' +
  '    () => hxChangeSubscriberStatus(env, token, {\n' +
  '      mobilitySubscriptionId: subId,\n' +
  '      subscriberNumber: mdn,\n' +
  '      reasonCode: "BBL",\n' +
  '      reasonCodeId: 20,\n' +
  '      subscriberState: "Resume On Cancel",\n' +
  '    }, runId, iccid, "fix_resume"),\n' +
  '    { attempts: 3, delayMs: 5000, label: `resume ${iccid}` }\n' +
  '  );';

src = src.replace(OLD_RESUME, NEW_RESUME);

// ── 4. Replace changeImei retryWithBackoff with retryUntilFulfilled ──────
const OLD_CHANGE =
  '    // Change IMEI on Helix\n' +
  '    console.log(`[FixSim] SIM ${iccid}: changing IMEI on Helix to ${newImei}`);\n' +
  '    await retryWithBackoff(\n' +
  '      () => hxChangeImei(env, token, subId, newImei, runId, iccid),\n' +
  '      { attempts: 3, label: `changeImei ${iccid}` }\n' +
  '    );';

if (!src.includes(OLD_CHANGE)) {
  console.error('Cannot find changeImei block'); process.exit(1);
}

const NEW_CHANGE =
  '    // Change IMEI on Helix\n' +
  '    console.log(`[FixSim] SIM ${iccid}: changing IMEI on Helix to ${newImei}`);\n' +
  '    await retryUntilFulfilled(\n' +
  '      () => hxChangeImei(env, token, subId, newImei, runId, iccid),\n' +
  '      { attempts: 3, delayMs: 5000, label: `changeImei ${iccid}` }\n' +
  '    );';

src = src.replace(OLD_CHANGE, NEW_CHANGE);

// ── Write back with CRLF ─────────────────────────────────────────────────
fs.writeFileSync(filePath, src.replace(/\n/g, '\r\n'), 'utf8');
console.log('Patch applied successfully.');
