// Patch: route fix-sim through a dedicated queue instead of ctx.waitUntil
// so it escapes the 30-second service-binding wall-clock limit.
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src', 'mdn-rotator', 'index.js');
let src = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');

// ── 1. Replace ctx.waitUntil block with queue send ───────────────────────
const OLD_WAIT =
  '        // For fix, run in background via ctx.waitUntil to avoid the ~40s\n' +
  '        // service-binding timeout. Returns immediately; results appear in Helix API Logs.\n' +
  '        if (action === "fix") {\n' +
  '          const token = await getCachedToken(env);\n' +
  '          ctx.waitUntil(\n' +
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
  '          );\n' +
  '          return new Response(JSON.stringify({\n' +
  '            ok: true,\n' +
  '            running: true,\n' +
  '            message: "Fix started — this takes ~40 seconds. Check the Helix API Logs below to confirm each step completed.",\n' +
  '            action, sim_id, iccid\n' +
  '          }, null, 2), {\n' +
  '            status: 200,\n' +
  '            headers: { "Content-Type": "application/json" }\n' +
  '          });\n' +
  '        }';

if (!src.includes(OLD_WAIT)) {
  console.error('Cannot find ctx.waitUntil fix block'); process.exit(1);
}

const NEW_WAIT =
  '        // For fix, send to dedicated queue so it runs outside the\n' +
  '        // 30-second service-binding wall-clock limit.\n' +
  '        if (action === "fix") {\n' +
  '          if (!env.FIX_SIM_QUEUE) {\n' +
  '            return new Response(JSON.stringify({ ok: false, error: "FIX_SIM_QUEUE binding not configured" }), {\n' +
  '              status: 500, headers: { "Content-Type": "application/json" }\n' +
  '            });\n' +
  '          }\n' +
  '          await env.FIX_SIM_QUEUE.send({ sim_id, iccid });\n' +
  '          return new Response(JSON.stringify({\n' +
  '            ok: true,\n' +
  '            running: true,\n' +
  '            message: "Fix queued — check the Helix API Logs below to confirm each step completed.",\n' +
  '            action, sim_id, iccid\n' +
  '          }, null, 2), {\n' +
  '            status: 200,\n' +
  '            headers: { "Content-Type": "application/json" }\n' +
  '          });\n' +
  '        }';

src = src.replace(OLD_WAIT, NEW_WAIT);

// ── 2. Update the queue handler to branch on batch.queue ─────────────────
const OLD_QUEUE =
  '  async queue(batch, env) {\n' +
  '    // Get cached token once for the entire batch\n' +
  '    const token = await getCachedToken(env);\n' +
  '\n' +
  '    for (const message of batch.messages) {\n' +
  '      const sim = message.body;\n' +
  '      const attempts = message.attempts || 0;\n' +
  '\n' +
  '      try {\n' +
  '        await rotateSingleSim(env, token, sim);\n' +
  '        message.ack();\n' +
  '        console.log(`SIM ${sim.iccid}: rotation complete`);\n' +
  '      } catch (err) {\n' +
  '        console.error(`SIM ${sim.iccid} failed (attempt ${attempts + 1}): ${err}`);\n' +
  '\n' +
  '        if (attempts >= 2) {\n' +
  '          // 3rd failure — record error for manual triage\n' +
  '          console.log(`SIM ${sim.iccid}: 3 failures reached, recording error`);\n' +
  '          await updateSimRotationError(env, sim.id, `Rotation failed after 3 attempts: ${err}`).catch(() => {});\n' +
  '          message.ack();\n' +
  '        } else {\n' +
  '          // Still have retries left — let the queue retry\n' +
  '          message.retry();\n' +
  '        }\n' +
  '      }\n' +
  '    }\n' +
  '  },';

if (!src.includes(OLD_QUEUE)) {
  console.error('Cannot find queue handler'); process.exit(1);
}

const NEW_QUEUE =
  '  async queue(batch, env) {\n' +
  '    if (batch.queue === "fix-sim-queue") {\n' +
  '      // Each message is one fix job; batch size is 1\n' +
  '      for (const msg of batch.messages) {\n' +
  '        const { sim_id, iccid } = msg.body;\n' +
  '        try {\n' +
  '          const token = await getCachedToken(env);\n' +
  '          await fixSim(env, token, sim_id, { autoRotate: false });\n' +
  '          msg.ack();\n' +
  '        } catch (err) {\n' +
  '          console.error("[FixSimQueue] error for SIM", sim_id, err);\n' +
  '          const errRunId = `fixsim_err_${iccid}_${Date.now()}`;\n' +
  '          await logHelixApiCall(env, {\n' +
  '            run_id: errRunId,\n' +
  '            step: "fix_sim_error",\n' +
  '            iccid,\n' +
  '            request_url: "internal",\n' +
  '            request_method: "N/A",\n' +
  '            request_body: { sim_id },\n' +
  '            response_status: 0,\n' +
  '            response_ok: false,\n' +
  '            error: String(err),\n' +
  '          }).catch(() => {});\n' +
  '          msg.ack(); // don\'t retry — already logged, user can re-trigger\n' +
  '        }\n' +
  '      }\n' +
  '      return;\n' +
  '    }\n' +
  '\n' +
  '    // Default: mdn-rotation-queue\n' +
  '    const token = await getCachedToken(env);\n' +
  '\n' +
  '    for (const message of batch.messages) {\n' +
  '      const sim = message.body;\n' +
  '      const attempts = message.attempts || 0;\n' +
  '\n' +
  '      try {\n' +
  '        await rotateSingleSim(env, token, sim);\n' +
  '        message.ack();\n' +
  '        console.log(`SIM ${sim.iccid}: rotation complete`);\n' +
  '      } catch (err) {\n' +
  '        console.error(`SIM ${sim.iccid} failed (attempt ${attempts + 1}): ${err}`);\n' +
  '\n' +
  '        if (attempts >= 2) {\n' +
  '          // 3rd failure — record error for manual triage\n' +
  '          console.log(`SIM ${sim.iccid}: 3 failures reached, recording error`);\n' +
  '          await updateSimRotationError(env, sim.id, `Rotation failed after 3 attempts: ${err}`).catch(() => {});\n' +
  '          message.ack();\n' +
  '        } else {\n' +
  '          // Still have retries left — let the queue retry\n' +
  '          message.retry();\n' +
  '        }\n' +
  '      }\n' +
  '    }\n' +
  '  },';

src = src.replace(OLD_QUEUE, NEW_QUEUE);

// ── Write back with CRLF ─────────────────────────────────────────────────
fs.writeFileSync(filePath, src.replace(/\n/g, '\r\n'), 'utf8');
console.log('Patch applied successfully.');
