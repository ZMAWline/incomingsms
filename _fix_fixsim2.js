// Fix 1: Log fixSim background errors to helix_api_logs (visible in UI)
// Fix 2: Remove subscriber details confirmation from step 4 (OTA only)
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src', 'mdn-rotator', 'index.js');
let src = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');

// ── Fix 1: background catch for "fix" action ─────────────────────────────
const OLD_CATCH =
  '        ctx.waitUntil(\n' +
  '            fixSim(env, token, sim_id, { autoRotate: false }).catch(err => {\n' +
  '              console.error("[SimAction/fix] background error:", err);\n' +
  '            })\n' +
  '          );';

if (!src.includes(OLD_CATCH)) {
  console.error('Cannot find background catch block'); process.exit(1);
}

const NEW_CATCH =
  '        ctx.waitUntil(\n' +
  '            fixSim(env, token, sim_id, { autoRotate: false }).catch(async err => {\n' +
  '              console.error("[SimAction/fix] background error:", err);\n' +
  '              const errRunId = `fixsim_err_${iccid}_${Date.now()}`;\n' +
  '              await logHelixApiCall(env, {\n' +
  '                run_id: errRunId,\n' +
  '                step: "fix_sim_error",\n' +
  '                iccid,\n' +
  '                request_url: "internal",\n' +
  '                request_method: "N/A",\n' +
  '                request_body: { sim_id },\n' +
  '                response_status: 0,\n' +
  '                response_ok: false,\n' +
  '                error: String(err),\n' +
  '              }).catch(() => {});\n' +
  '            })\n' +
  '          );';

src = src.replace(OLD_CATCH, NEW_CATCH);

// ── Fix 2: Remove subscriber details confirmation block ───────────────────
const OLD_CONFIRM =
  '\n    // Confirm Active status from Helix and update DB\n' +
  '    console.log(`[FixSim] SIM ${iccid}: confirming status from Helix`);\n' +
  '    const confirmDetails = await retryWithBackoff(\n' +
  '      () => hxSubscriberDetails(env, token, subId, runId, iccid),\n' +
  '      { attempts: 3, label: `confirmDetails ${iccid}` }\n' +
  '    );\n' +
  '    const cd = Array.isArray(confirmDetails) ? confirmDetails[0] : null;\n' +
  '    const helixStatusMap = {\n' +
  '      Active: "active", ACTIVE: "active", ACTIVATED: "active",\n' +
  '      Suspended: "suspended", SUSPENDED: "suspended",\n' +
  '      Canceled: "canceled", CANCELED: "canceled",\n' +
  '    };\n' +
  '    const confirmedStatus = helixStatusMap[cd?.status] || null;\n' +
  '    if (confirmedStatus) {\n' +
  '      await supabasePatch(\n' +
  '        env,\n' +
  '        `sims?id=eq.${encodeURIComponent(String(simId))}`,\n' +
  '        { status: confirmedStatus }\n' +
  '      );\n' +
  '      console.log(`[FixSim] SIM ${iccid}: confirmed Helix status = ${confirmedStatus}`);\n' +
  '    }\n';

if (!src.includes(OLD_CONFIRM)) {
  console.error('Cannot find confirm details block'); process.exit(1);
}

src = src.replace(OLD_CONFIRM, '\n');

// ── Write back with CRLF ─────────────────────────────────────────────────
fs.writeFileSync(filePath, src.replace(/\n/g, '\r\n'), 'utf8');
console.log('Patch applied successfully.');
