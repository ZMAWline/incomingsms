// Patch: rewrite fixSim with new flow:
// 1. Cancel  2. Resume  3. New IMEI (eligibility → Helix change → gateway set → pool update)  4. OTA refresh → confirm Active → update status
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src', 'mdn-rotator', 'index.js');
let src = fs.readFileSync(filePath, 'utf8');

// Normalize to LF for reliable string matching
src = src.replace(/\r\n/g, '\n');

const START_MARKER = '// ===========================\n// Fix SIM - IMEI change + OTA Refresh + Cancel + Resume\n// ===========================\nasync function fixSim(env, token, simId, { autoRotate = false } = {}) {';
const END_MARKER = '// ===========================\n// IMEI Pool helpers\n// ===========================';

const start = src.indexOf(START_MARKER);
if (start === -1) { console.error('START_MARKER not found'); process.exit(1); }

const end = src.indexOf(END_MARKER, start);
if (end === -1) { console.error('END_MARKER not found'); process.exit(1); }

const newFixSim = `// ===========================
// Fix SIM - Cancel → Resume → New IMEI (eligibility + Helix + gateway) → OTA confirm
// ===========================
async function fixSim(env, token, simId, { autoRotate = false } = {}) {
  // Load SIM details from DB
  const sims = await supabaseSelect(
    env,
    \`sims?select=id,iccid,mobility_subscription_id,gateway_id,port,slot,current_imei_pool_id&id=eq.\${encodeURIComponent(String(simId))}&limit=1\`
  );
  if (!Array.isArray(sims) || sims.length === 0) {
    throw new Error(\`SIM not found: \${simId}\`);
  }
  const sim = sims[0];
  const iccid = sim.iccid;
  const subId = sim.mobility_subscription_id;
  const runId = \`fixsim_\${iccid}_\${Date.now()}\`;

  if (!subId) throw new Error(\`SIM \${iccid}: no mobility_subscription_id\`);
  if (!sim.gateway_id) throw new Error(\`SIM \${iccid}: no gateway_id\`);
  if (!sim.port) throw new Error(\`SIM \${iccid}: no port\`);

  console.log(\`[FixSim] Starting for SIM \${simId} (\${iccid})\`);

  // Get subscriber details upfront (need mdn + attBan for cancel/resume/OTA)
  const details = await retryWithBackoff(
    () => hxSubscriberDetails(env, token, subId, runId, iccid),
    { attempts: 3, label: \`subscriberDetails \${iccid}\` }
  );
  const d = Array.isArray(details) ? details[0] : null;
  const subscriberNumber = d?.phoneNumber;
  const attBan = d?.attBan || d?.ban || null;

  if (!subscriberNumber) {
    throw new Error(\`SIM \${iccid}: no phoneNumber from Helix\`);
  }

  const mdn = String(subscriberNumber).replace(/\\D/g, "").replace(/^1/, "");

  // Step 1: Cancel
  console.log(\`[FixSim] SIM \${iccid}: canceling subscriber \${mdn}\`);
  await retryWithBackoff(
    () => hxChangeSubscriberStatus(env, token, {
      mobilitySubscriptionId: subId,
      subscriberNumber: mdn,
      reasonCode: "CAN",
      reasonCodeId: 1,
      subscriberState: "Cancel",
    }, runId, iccid, "fix_cancel"),
    { attempts: 3, label: \`cancel \${iccid}\` }
  );
  await sleep(3000);

  // Step 2: Resume On Cancel
  console.log(\`[FixSim] SIM \${iccid}: resuming subscriber \${mdn}\`);
  await retryWithBackoff(
    () => hxChangeSubscriberStatus(env, token, {
      mobilitySubscriptionId: subId,
      subscriberNumber: mdn,
      reasonCode: "BBL",
      reasonCodeId: 20,
      subscriberState: "Resume On Cancel",
    }, runId, iccid, "fix_resume"),
    { attempts: 3, label: \`resume \${iccid}\` }
  );
  await sleep(5000); // wait for Helix to restore subscriber

  // Step 3: Retire old IMEI pool entry + allocate new one
  await retireAllPoolEntriesForSim(env, simId, sim.current_imei_pool_id);

  const poolEntry = await allocateImeiFromPool(env, simId);
  const newImei = poolEntry.imei;
  console.log(\`[FixSim] SIM \${iccid}: allocated IMEI \${newImei} (pool entry \${poolEntry.id})\`);

  try {
    // Check IMEI eligibility with Helix
    console.log(\`[FixSim] SIM \${iccid}: checking eligibility for IMEI \${newImei}\`);
    const eligibility = await hxCheckImeiEligibility(env, token, newImei);
    if (eligibility.isImeiValid !== true) {
      throw new Error(\`IMEI \${newImei} is not eligible for this carrier/plan\`);
    }

    // Change IMEI on Helix
    console.log(\`[FixSim] SIM \${iccid}: changing IMEI on Helix to \${newImei}\`);
    await retryWithBackoff(
      () => hxChangeImei(env, token, subId, newImei, runId, iccid),
      { attempts: 3, label: \`changeImei \${iccid}\` }
    );

    // Set IMEI on gateway
    await retryWithBackoff(
      () => callSkylineSetImei(env, sim.gateway_id, sim.port, newImei),
      { attempts: 3, label: \`setImei \${iccid}\` }
    );
    console.log(\`[FixSim] SIM \${iccid}: IMEI set on gateway\`);

    // Update IMEI pool entry with gateway/port
    await supabasePatch(
      env,
      \`imei_pool?id=eq.\${encodeURIComponent(String(poolEntry.id))}\`,
      { gateway_id: sim.gateway_id, port: sim.port, updated_at: new Date().toISOString() }
    );

    // Update SIM record with new IMEI
    await supabasePatch(
      env,
      \`sims?id=eq.\${encodeURIComponent(String(simId))}\`,
      { imei: newImei, current_imei_pool_id: poolEntry.id }
    );

    // Step 4: OTA Refresh
    await sleep(2000);
    if (attBan) {
      console.log(\`[FixSim] SIM \${iccid}: OTA Refresh (ban=\${attBan})\`);
      await retryWithBackoff(
        () => hxOtaRefresh(env, token, { ban: attBan, subscriberNumber: mdn, iccid }, runId, iccid),
        { attempts: 3, label: \`otaRefresh \${iccid}\` }
      );
      await sleep(3000);
    } else {
      console.log(\`[FixSim] SIM \${iccid}: skipping OTA Refresh (no attBan)\`);
    }

    // Confirm Active status from Helix and update DB
    console.log(\`[FixSim] SIM \${iccid}: confirming status from Helix\`);
    const confirmDetails = await retryWithBackoff(
      () => hxSubscriberDetails(env, token, subId, runId, iccid),
      { attempts: 3, label: \`confirmDetails \${iccid}\` }
    );
    const cd = Array.isArray(confirmDetails) ? confirmDetails[0] : null;
    const helixStatusMap = {
      Active: "active", ACTIVE: "active", ACTIVATED: "active",
      Suspended: "suspended", SUSPENDED: "suspended",
      Canceled: "canceled", CANCELED: "canceled",
    };
    const confirmedStatus = helixStatusMap[cd?.status] || null;
    if (confirmedStatus) {
      await supabasePatch(
        env,
        \`sims?id=eq.\${encodeURIComponent(String(simId))}\`,
        { status: confirmedStatus }
      );
      console.log(\`[FixSim] SIM \${iccid}: confirmed Helix status = \${confirmedStatus}\`);
    }

  } catch (err) {
    // Rollback: release the newly allocated IMEI (cancel/resume already happened, can't undo those)
    console.error(\`[FixSim] SIM \${iccid}: failed in IMEI/OTA phase, rolling back IMEI allocation: \${err}\`);
    try {
      await releaseImeiPoolEntry(env, poolEntry.id, simId);
    } catch (rollbackErr) {
      console.error(\`[FixSim] SIM \${iccid}: rollback release failed: \${rollbackErr}\`);
    }
    throw err;
  }

  // If autoRotate, re-queue for MDN rotation
  if (autoRotate) {
    await env.MDN_QUEUE.send({
      id: sim.id,
      iccid: sim.iccid,
      mobility_subscription_id: subId,
      status: 'active',
      _recoveryAttempt: true,
    });
    console.log(\`[FixSim] SIM \${iccid}: re-queued for rotation\`);
  }

  console.log(\`[FixSim] SIM \${iccid}: fix complete (IMEI=\${newImei})\`);
  return { imei: newImei, pool_entry_id: poolEntry.id };
}

`;

src = src.slice(0, start) + newFixSim + END_MARKER + src.slice(end + END_MARKER.length);

// Write back with CRLF
src = src.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, src, 'utf8');
console.log('fixSim rewritten successfully.');
