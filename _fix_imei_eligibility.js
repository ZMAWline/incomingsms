'use strict';
// Patch script: add IMEI eligibility + change_imei to mdn-rotator
// Run: node _fix_imei_eligibility.js

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src', 'mdn-rotator', 'index.js');
let src = fs.readFileSync(filePath, 'utf8');

// Normalize to LF for easier searching
src = src.replace(/\r\n/g, '\n');

// ===================================================================
// 1. Add new routes in the fetch handler
//    Insert BEFORE the final health-check return at end of fetch()
// ===================================================================

const HEALTH_CHECK_MARKER = 'return new Response("mdn-rotator ok. Use /run?secret=...&limit=1, /rotate-sim?secret=...&iccid=..., or /error-summary?secret=...", { status: 200 });\n  },';

const NEW_ROUTES = `
    if (url.pathname === "/check-imei" && request.method === "GET") {
      const secret = url.searchParams.get("secret") || "";
      if (!env.ADMIN_RUN_SECRET || secret !== env.ADMIN_RUN_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
      const imei = url.searchParams.get("imei") || "";
      if (!/^\\d{15}$/.test(imei)) {
        return new Response(JSON.stringify({ error: "imei must be 15 digits" }), {
          status: 400, headers: { "Content-Type": "application/json" }
        });
      }
      try {
        const token = await getCachedToken(env);
        const result = await hxCheckImeiEligibility(env, token, imei);
        return new Response(JSON.stringify({ ok: true, imei, eligible: result.isImeiValid === true, result }, null, 2), {
          status: 200, headers: { "Content-Type": "application/json" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ ok: false, imei, error: String(err) }), {
          status: 500, headers: { "Content-Type": "application/json" }
        });
      }
    }

    if (url.pathname === "/check-imeis" && request.method === "POST") {
      const secret = url.searchParams.get("secret") || "";
      if (!env.ADMIN_RUN_SECRET || secret !== env.ADMIN_RUN_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
      try {
        const body = await request.json();
        const imeis = Array.isArray(body.imeis) ? body.imeis.slice(0, 100) : [];
        if (imeis.length === 0) {
          return new Response(JSON.stringify({ error: "imeis array is required (max 100)" }), {
            status: 400, headers: { "Content-Type": "application/json" }
          });
        }
        const token = await getCachedToken(env);
        const results = [];
        for (const rawImei of imeis) {
          const imei = String(rawImei).trim();
          if (!/^\\d{15}$/.test(imei)) {
            results.push({ imei, eligible: false, error: "Invalid format (not 15 digits)" });
            continue;
          }
          try {
            const result = await hxCheckImeiEligibility(env, token, imei);
            results.push({ imei, eligible: result.isImeiValid === true, result });
          } catch (err) {
            results.push({ imei, eligible: false, error: String(err) });
          }
        }
        return new Response(JSON.stringify({ ok: true, results }, null, 2), {
          status: 200, headers: { "Content-Type": "application/json" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ ok: false, error: String(err) }), {
          status: 500, headers: { "Content-Type": "application/json" }
        });
      }
    }

    if (url.pathname === "/fix-incompatible-imei" && request.method === "POST") {
      const secret = url.searchParams.get("secret") || "";
      if (!env.ADMIN_RUN_SECRET || secret !== env.ADMIN_RUN_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
      try {
        const body = await request.json();
        const { imei, gateway_id, port } = body;
        if (!imei || !gateway_id || !port) {
          return new Response(JSON.stringify({ error: "imei, gateway_id, and port are required" }), {
            status: 400, headers: { "Content-Type": "application/json" }
          });
        }
        // Retire bad IMEI in pool
        await supabasePatch(env, 'imei_pool?imei=eq.' + encodeURIComponent(imei) + '&status=eq.in_use', {
          status: 'retired',
          sim_id: null,
          assigned_at: null,
          updated_at: new Date().toISOString(),
        });
        const token = await getCachedToken(env);
        // Try up to 3 pool IMEIs until we find an eligible one
        let newImei = null;
        let eligibility = null;
        let poolEntry = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          // Allocate available IMEI (no sim_id — this is a gateway slot fix, not tied to a SIM)
          const available = await supabaseSelect(env, 'imei_pool?select=id,imei&status=eq.available&order=id.asc&limit=1');
          if (!Array.isArray(available) || available.length === 0) {
            throw new Error("No available IMEIs in pool");
          }
          const candidate = available[0];
          // Check eligibility
          const result = await hxCheckImeiEligibility(env, token, candidate.imei);
          if (result.isImeiValid !== true) {
            // Retire ineligible IMEI and try next
            await supabasePatch(env, 'imei_pool?id=eq.' + encodeURIComponent(String(candidate.id)), {
              status: 'retired', updated_at: new Date().toISOString(),
            });
            continue;
          }
          // Set on gateway
          await callSkylineSetImei(env, gateway_id, port, candidate.imei);
          // Mark as in_use for this slot (no sim_id)
          await supabasePatch(env, 'imei_pool?id=eq.' + encodeURIComponent(String(candidate.id)), {
            status: 'in_use',
            gateway_id,
            port,
            assigned_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
          newImei = candidate.imei;
          eligibility = result;
          poolEntry = candidate;
          break;
        }
        if (!newImei) {
          throw new Error("Could not find an eligible replacement IMEI after 3 attempts");
        }
        return new Response(JSON.stringify({ ok: true, old_imei: imei, new_imei: newImei, eligibility }, null, 2), {
          status: 200, headers: { "Content-Type": "application/json" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ ok: false, error: String(err) }), {
          status: 500, headers: { "Content-Type": "application/json" }
        });
      }
    }

`;

if (!src.includes(HEALTH_CHECK_MARKER)) {
  console.error('ERROR: health check marker not found in mdn-rotator');
  process.exit(1);
}

src = src.replace(HEALTH_CHECK_MARKER, NEW_ROUTES + HEALTH_CHECK_MARKER);
console.log('✓ Inserted new routes before health check return');

// ===================================================================
// 2. Add change_imei to validActions in /sim-action handler
// ===================================================================

const VALID_ACTIONS_OLD = 'const validActions = ["ota_refresh", "cancel", "resume", "rotate", "fix", "retry_activation"];';
const VALID_ACTIONS_NEW = 'const validActions = ["ota_refresh", "cancel", "resume", "rotate", "fix", "retry_activation", "change_imei"];';

if (!src.includes(VALID_ACTIONS_OLD)) {
  console.error('ERROR: validActions line not found');
  process.exit(1);
}
src = src.replace(VALID_ACTIONS_OLD, VALID_ACTIONS_NEW);
console.log('✓ Added change_imei to validActions');

// ===================================================================
// 3. Add change_imei handler block in /sim-action
//    Insert BEFORE "For retry_activation" block
// ===================================================================

const RETRY_ACTIVATION_MARKER = '        // For retry_activation — handles its own SIM loading\n        if (action === "retry_activation") {';

const CHANGE_IMEI_HANDLER = `        // For change_imei — full IMEI swap flow
        if (action === "change_imei") {
          const autoImei = body.auto_imei === true;
          const newImeiRaw = body.new_imei ? String(body.new_imei).trim() : null;

          if (!autoImei && (!newImeiRaw || !/^\\d{15}$/.test(newImeiRaw))) {
            return new Response(JSON.stringify({ ok: false, error: "new_imei must be 15 digits, or set auto_imei: true" }), {
              status: 400, headers: { "Content-Type": "application/json" }
            });
          }
          if (!sim.gateway_id || !sim.port) {
            return new Response(JSON.stringify({ ok: false, error: "SIM must have gateway_id and port to change IMEI" }), {
              status: 400, headers: { "Content-Type": "application/json" }
            });
          }
          if (!subId) {
            return new Response(JSON.stringify({ ok: false, error: "SIM must have mobility_subscription_id to change IMEI" }), {
              status: 400, headers: { "Content-Type": "application/json" }
            });
          }

          const hxToken = await getCachedToken(env);
          const changeRunId = \`change_imei_\${iccid}_\${Date.now()}\`;
          let allocatedEntry = null;
          let targetImei = newImeiRaw;

          try {
            if (autoImei) {
              // Allocate from pool — temporarily attach to sim_id
              allocatedEntry = await allocateImeiFromPool(env, sim_id);
              targetImei = allocatedEntry.imei;
              console.log(\`[ChangeImei] SIM \${iccid}: auto-allocated IMEI \${targetImei}\`);
            }

            // Check eligibility
            const eligibility = await hxCheckImeiEligibility(env, hxToken, targetImei);
            if (eligibility.isImeiValid !== true) {
              if (allocatedEntry) await releaseImeiPoolEntry(env, allocatedEntry.id, sim_id).catch(() => {});
              return new Response(JSON.stringify({
                ok: false,
                error: \`IMEI \${targetImei} is not eligible for this carrier/plan\`,
                eligibility
              }), { status: 400, headers: { "Content-Type": "application/json" } });
            }

            // Set IMEI on gateway
            try {
              await callSkylineSetImei(env, sim.gateway_id, sim.port, targetImei);
            } catch (gwErr) {
              if (allocatedEntry) await releaseImeiPoolEntry(env, allocatedEntry.id, sim_id).catch(() => {});
              throw gwErr;
            }

            // Retire old in_use IMEI for this slot in the pool
            await supabasePatch(
              env,
              \`imei_pool?gateway_id=eq.\${encodeURIComponent(String(sim.gateway_id))}&port=eq.\${encodeURIComponent(sim.port)}&status=eq.in_use\`,
              { status: 'retired', sim_id: null, assigned_at: null, updated_at: new Date().toISOString() }
            );

            // Upsert new IMEI in pool as in_use for this slot
            if (!allocatedEntry) {
              // Manual IMEI: add to pool as in_use
              const upsertRes = await fetch(\`\${env.SUPABASE_URL}/rest/v1/imei_pool?on_conflict=imei\`, {
                method: 'POST',
                headers: {
                  apikey: env.SUPABASE_SERVICE_ROLE_KEY,
                  Authorization: \`Bearer \${env.SUPABASE_SERVICE_ROLE_KEY}\`,
                  'Content-Type': 'application/json',
                  Prefer: 'resolution=merge-duplicates,return=representation',
                },
                body: JSON.stringify([{
                  imei: targetImei,
                  status: 'in_use',
                  gateway_id: sim.gateway_id,
                  port: sim.port,
                  sim_id,
                  assigned_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                }]),
              });
              if (!upsertRes.ok) {
                const errTxt = await upsertRes.text();
                console.error(\`[ChangeImei] Pool upsert failed: \${upsertRes.status} \${errTxt}\`);
              }
            } else {
              // Auto IMEI: update the allocated entry with gateway_id/port
              await supabasePatch(
                env,
                \`imei_pool?id=eq.\${encodeURIComponent(String(allocatedEntry.id))}\`,
                { gateway_id: sim.gateway_id, port: sim.port, updated_at: new Date().toISOString() }
              );
            }

            // Change IMEI on Helix
            const helixResult = await hxChangeImei(env, hxToken, subId, targetImei, changeRunId, iccid);

            // Update SIM record
            await supabasePatch(env, \`sims?id=eq.\${encodeURIComponent(String(sim_id))}\`, {
              imei: targetImei,
              current_imei_pool_id: allocatedEntry ? allocatedEntry.id : null,
            });

            return new Response(JSON.stringify({
              ok: true, action, sim_id, iccid, imei: targetImei, eligibility, detail: helixResult
            }, null, 2), { status: 200, headers: { "Content-Type": "application/json" } });

          } catch (err) {
            return new Response(JSON.stringify({ ok: false, error: String(err) }), {
              status: 500, headers: { "Content-Type": "application/json" }
            });
          }
        }

`;

if (!src.includes(RETRY_ACTIVATION_MARKER)) {
  console.error('ERROR: retry_activation marker not found');
  process.exit(1);
}
src = src.replace(RETRY_ACTIVATION_MARKER, CHANGE_IMEI_HANDLER + RETRY_ACTIVATION_MARKER);
console.log('✓ Inserted change_imei handler in /sim-action');

// ===================================================================
// 4. Add hxCheckImeiEligibility and hxChangeImei functions
//    Insert BEFORE retireImeiPoolEntry (IMEI Pool helpers section)
// ===================================================================

const IMEI_HELPERS_MARKER = 'async function retireImeiPoolEntry(env, poolEntryId, simId) {';

const NEW_HX_FUNCTIONS = `// ===========================
// Helix IMEI Eligibility Check
// ===========================
async function hxCheckImeiEligibility(env, token, imei) {
  const url = \`\${env.HX_API_BASE}/api/plans-by-imei/\${encodeURIComponent(imei)}?skuId=3&resellerId=\${encodeURIComponent(env.HX_ACTIVATION_CLIENT_ID)}\`;
  const method = "GET";
  const runId = \`check_imei_\${imei}_\${Date.now()}\`;

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: \`Bearer \${token}\`,
      "Content-Type": "application/json",
    },
  });

  const responseText = await res.text();
  let json = {};
  try { json = JSON.parse(responseText); } catch {}

  await logHelixApiCall(env, {
    run_id: runId,
    step: "check_imei_eligibility",
    imei,
    request_url: url,
    request_method: method,
    request_body: null,
    response_status: res.status,
    response_ok: res.ok,
    response_body_text: responseText,
    response_body_json: json,
    error: res.ok ? null : \`IMEI eligibility check failed: \${res.status}\`,
  });

  // 406 = IMEI not found / not eligible; 200 = eligible with plans
  if (res.status === 406 || (res.status === 404)) {
    return { isImeiValid: false, status: res.status, raw: json };
  }

  if (!res.ok) {
    throw new Error(\`IMEI eligibility check failed \${res.status}: \${responseText.slice(0, 200)}\`);
  }

  // Attach isImeiValid for easy checking
  if (typeof json.isImeiValid === 'undefined') {
    json.isImeiValid = res.ok && res.status === 200;
  }
  return json;
}

// ===========================
// Helix Change IMEI
// ===========================
async function hxChangeImei(env, token, mobilitySubscriptionId, newImei, runId, iccid) {
  const url = \`\${env.HX_API_BASE}/api/mobility-sub-ops/imei-plan\`;
  const method = "PATCH";
  const requestBody = [{ mobilitySubscriptionId, imei: newImei }];

  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: \`Bearer \${token}\`,
    },
    body: JSON.stringify(requestBody),
  });

  const responseText = await res.text();
  let json = {};
  try { json = JSON.parse(responseText); } catch {}

  await logHelixApiCall(env, {
    run_id: runId,
    step: "change_imei",
    iccid,
    imei: newImei,
    request_url: url,
    request_method: method,
    request_body: requestBody,
    response_status: res.status,
    response_ok: res.ok,
    response_body_text: responseText,
    response_body_json: json,
    error: res.ok ? null : \`Change IMEI failed: \${res.status}\`,
  });

  if (!res.ok) {
    throw new Error(\`Change IMEI failed \${res.status}: \${responseText.slice(0, 300)}\`);
  }

  // Check that successful array is non-empty
  if (Array.isArray(json.successful) && json.successful.length === 0) {
    throw new Error(\`Change IMEI: no successful items. Failed: \${JSON.stringify(json.failed)}\`);
  }

  return json;
}

`;

if (!src.includes(IMEI_HELPERS_MARKER)) {
  console.error('ERROR: retireImeiPoolEntry marker not found');
  process.exit(1);
}
src = src.replace(IMEI_HELPERS_MARKER, NEW_HX_FUNCTIONS + IMEI_HELPERS_MARKER);
console.log('✓ Inserted hxCheckImeiEligibility and hxChangeImei functions');

// ===================================================================
// Convert back to CRLF and write
// ===================================================================
const out = src.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, out, 'utf8');
console.log('✓ Written mdn-rotator/index.js with CRLF line endings');
console.log('Done. Run: node --input-type=module --check < src/mdn-rotator/index.js');
