'use strict';
// Patch: make Cancel and Resume On Cancel unconditional in fixSim()
// Run: node _fix_fixsim_unconditional.js

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src', 'mdn-rotator', 'index.js');
let src = fs.readFileSync(filePath, 'utf8');

// Normalize to LF
src = src.replace(/\r\n/g, '\n');

const OLD =
  '    // 8) Cancel (only if subscriber is active on carrier side)\n' +
  '    let cancelAttempted = false;\n' +
  '    if (subscriberStatus === \'ACTIVATED\' || subscriberStatus === \'ACTIVE\') {\n' +
  '      console.log(`[FixSim] SIM ${iccid}: canceling subscriber ${mdn} (status=${subscriberStatus})`);\n' +
  '      try {\n' +
  '        await retryWithBackoff(\n' +
  '          () => hxChangeSubscriberStatus(env, token, {\n' +
  '            mobilitySubscriptionId: subId,\n' +
  '            subscriberNumber: mdn,\n' +
  '            reasonCode: "CAN",\n' +
  '            reasonCodeId: 1,\n' +
  '            subscriberState: "Cancel",\n' +
  '          }, runId, iccid, "fix_cancel"),\n' +
  '          { attempts: 3, label: `cancel ${iccid}` }\n' +
  '        );\n' +
  '        cancelAttempted = true;\n' +
  '        await sleep(3000);\n' +
  '      } catch (cancelErr) {\n' +
  '        const msg = String(cancelErr);\n' +
  '        if (msg.includes(\'Must Be Active\') || msg.includes(\'not active\') || msg.includes(\'must be active\')) {\n' +
  '          console.warn(`[FixSim] SIM ${iccid}: Cancel soft-fail (already cancelled?): ${msg}`);\n' +
  '          cancelAttempted = true; // still need Resume\n' +
  '        } else {\n' +
  '          throw cancelErr;\n' +
  '        }\n' +
  '      }\n' +
  '    } else {\n' +
  '      console.log(`[FixSim] SIM ${iccid}: skipping cancel (carrier status=${subscriberStatus})`);\n' +
  '    }\n' +
  '\n' +
  '    // 9) Resume On Cancel — only if cancel was attempted (succeeded or soft-failed)\n' +
  '    if (cancelAttempted) {\n' +
  '      console.log(`[FixSim] SIM ${iccid}: resuming subscriber ${mdn}`);\n' +
  '      await retryWithBackoff(\n' +
  '        () => hxChangeSubscriberStatus(env, token, {\n' +
  '          mobilitySubscriptionId: subId,\n' +
  '          subscriberNumber: mdn,\n' +
  '          reasonCode: "BBL",\n' +
  '          reasonCodeId: 20,\n' +
  '          subscriberState: "Resume On Cancel",\n' +
  '        }, runId, iccid, "fix_resume"),\n' +
  '        { attempts: 3, label: `resume ${iccid}` }\n' +
  '      );\n' +
  '      await sleep(3000);\n' +
  '    } else {\n' +
  '      console.log(`[FixSim] SIM ${iccid}: skipping resume (cancel was not attempted)`);\n' +
  '    }';

const NEW =
  '    // 8) Cancel\n' +
  '    console.log(`[FixSim] SIM ${iccid}: canceling subscriber ${mdn}`);\n' +
  '    await retryWithBackoff(\n' +
  '      () => hxChangeSubscriberStatus(env, token, {\n' +
  '        mobilitySubscriptionId: subId,\n' +
  '        subscriberNumber: mdn,\n' +
  '        reasonCode: "CAN",\n' +
  '        reasonCodeId: 1,\n' +
  '        subscriberState: "Cancel",\n' +
  '      }, runId, iccid, "fix_cancel"),\n' +
  '      { attempts: 3, label: `cancel ${iccid}` }\n' +
  '    );\n' +
  '    await sleep(3000);\n' +
  '\n' +
  '    // 9) Resume On Cancel\n' +
  '    console.log(`[FixSim] SIM ${iccid}: resuming subscriber ${mdn}`);\n' +
  '    await retryWithBackoff(\n' +
  '      () => hxChangeSubscriberStatus(env, token, {\n' +
  '        mobilitySubscriptionId: subId,\n' +
  '        subscriberNumber: mdn,\n' +
  '        reasonCode: "BBL",\n' +
  '        reasonCodeId: 20,\n' +
  '        subscriberState: "Resume On Cancel",\n' +
  '      }, runId, iccid, "fix_resume"),\n' +
  '      { attempts: 3, label: `resume ${iccid}` }\n' +
  '    );\n' +
  '    await sleep(3000);';

if (!src.includes(OLD)) {
  console.error('ERROR: conditional cancel/resume block not found');
  process.exit(1);
}

src = src.replace(OLD, NEW);
console.log('✓ Cancel and Resume On Cancel are now unconditional');

// Write with CRLF
const out = src.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, out, 'utf8');
console.log('✓ Written src/mdn-rotator/index.js');
