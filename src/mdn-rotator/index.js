import { syncSimFromHelixDetails } from '../shared/subscriber-sync.js';
import { pickRandomAddress } from '../shared/address-pool.js';

// =========================================================
// MDN ROTATOR WORKER
// Daily phone number rotation at 5:00 AM UTC
// Error summary notification at 7:00 AM UTC
// Includes: webhook deduplication and retry
// =========================================================

export default {
  // HTTP endpoint for manual triggering
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/run") {
      const secret = url.searchParams.get("secret") || "";
      if (!env.ADMIN_RUN_SECRET || secret !== env.ADMIN_RUN_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }

      const limit = parseInt(url.searchParams.get("limit") || "0", 10) || null;
      const result = await queueSimsForRotation(env, { limit });
      return new Response(JSON.stringify(result, null, 2), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    if (url.pathname === "/rotate-sim") {
      const secret = url.searchParams.get("secret") || "";
      if (!env.ADMIN_RUN_SECRET || secret !== env.ADMIN_RUN_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }

      const iccid = url.searchParams.get("iccid") || "";
      if (!iccid) {
        return new Response(JSON.stringify({ error: "iccid parameter is required" }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      }

      const result = await rotateSpecificSim(env, iccid);
      return new Response(JSON.stringify(result, null, 2), {
        status: result.ok ? 200 : 500,
        headers: { "Content-Type": "application/json" }
      });
    }

    if (url.pathname === "/fix-sim" && request.method === "POST") {
      const secret = url.searchParams.get("secret") || "";
      if (!env.ADMIN_RUN_SECRET || secret !== env.ADMIN_RUN_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }

      try {
        const body = await request.json();
        const simIds = body.sim_ids || [];
        if (!Array.isArray(simIds) || simIds.length === 0) {
          return new Response(JSON.stringify({ error: "sim_ids array is required" }), {
            status: 400,
            headers: { "Content-Type": "application/json" }
          });
        }

        const token = await getCachedToken(env);
        const results = [];
        for (const simId of simIds) {
          try {
            const result = await fixSim(env, token, simId, { autoRotate: false });
            results.push({ sim_id: simId, ok: true, ...result });
          } catch (err) {
            results.push({ sim_id: simId, ok: false, error: String(err) });
          }
        }

        return new Response(JSON.stringify({ ok: true, results }, null, 2), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    if (url.pathname === "/imei-sweep" && request.method === "POST") {
      const secret = url.searchParams.get("secret") || "";
      if (!env.ADMIN_RUN_SECRET || secret !== env.ADMIN_RUN_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
      try {
        if (!env.FIX_SIM_QUEUE) {
          return new Response(JSON.stringify({ error: "FIX_SIM_QUEUE not configured" }), {
            status: 500, headers: { "Content-Type": "application/json" }
          });
        }
        const suspended = await supabaseSelect(
          env,
          `sims?select=id,iccid&status=eq.suspended&gateway_id=not.is.null&port=not.is.null&mobility_subscription_id=not.is.null&limit=200`
        );
        if (!Array.isArray(suspended) || suspended.length === 0) {
          return new Response(JSON.stringify({ ok: true, queued: 0, message: "No suspended SIMs found" }), {
            status: 200, headers: { "Content-Type": "application/json" }
          });
        }
        let queued = 0;
        for (const sim of suspended) {
          await env.FIX_SIM_QUEUE.send({ sim_id: sim.id, iccid: sim.iccid });
          queued++;
        }
        return new Response(JSON.stringify({ ok: true, queued, sim_ids: suspended.map(s => s.id) }, null, 2), {
          status: 200, headers: { "Content-Type": "application/json" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), {
          status: 500, headers: { "Content-Type": "application/json" }
        });
      }
    }

    if (url.pathname === "/trigger-blimei-sweep" && request.method === "POST") {
      const secret = url.searchParams.get("secret") || "";
      if (!env.ADMIN_RUN_SECRET || secret !== env.ADMIN_RUN_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
      try {
        const result = await queueBlimeiUpdates(env);
        return new Response(JSON.stringify({ ok: true, ...result }), {
          status: 200, headers: { "Content-Type": "application/json" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), {
          status: 500, headers: { "Content-Type": "application/json" }
        });
      }
    }

    if (url.pathname === "/imei-gateway-sync" && request.method === "POST") {
      const secret = url.searchParams.get("secret") || "";
      if (!env.ADMIN_RUN_SECRET || secret !== env.ADMIN_RUN_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
      try {
        const body = await request.json();
        const simList = Array.isArray(body.sims) ? body.sims : [];
        if (simList.length === 0) {
          return new Response(JSON.stringify({ error: "sims array is required" }), {
            status: 400, headers: { "Content-Type": "application/json" }
          });
        }
        if (simList.length > 20) {
          return new Response(JSON.stringify({ error: "max 20 SIMs per call" }), {
            status: 400, headers: { "Content-Type": "application/json" }
          });
        }

        const token = await getCachedToken(env);
        const runId = `imei-sync-${Date.now()}`;
        const results = [];

        for (const item of simList) {
          const { id: simId, needs_ota, target_imei } = item;
          try {
            const rows = await supabaseSelect(
              env,
              `sims?select=id,iccid,gateway_id,port,att_ban,imei,mobility_subscription_id,sim_numbers(e164)&id=eq.${encodeURIComponent(String(simId))}&limit=1&sim_numbers.valid_to=is.null`
            );
            if (!Array.isArray(rows) || rows.length === 0) {
              results.push({ sim_id: simId, ok: false, error: "SIM not found" });
              continue;
            }
            const sim = rows[0];
            const { iccid, gateway_id, port } = sim;

            if (!gateway_id || !port) {
              results.push({ sim_id: simId, iccid, ok: false, error: "No gateway/port assigned" });
              continue;
            }

            let blimei;
            if (!needs_ota) {
              blimei = target_imei;
            } else {
              const attBan = sim.att_ban;
              const mdnRaw = Array.isArray(sim.sim_numbers) && sim.sim_numbers.length > 0
                ? sim.sim_numbers[0].e164
                : null;
              const mdn = mdnRaw ? String(mdnRaw).replace(/\D/g, "").replace(/^1/, "") : null;

              if (!attBan && sim.mobility_subscription_id) {
                // No att_ban: use subscriber details to get billingImei + backfill att_ban
                console.log(`[ImeiGatewaySync] SIM ${iccid}: no att_ban — fetching subscriber details`);
                const details = await hxSubscriberDetails(env, token, sim.mobility_subscription_id, runId, iccid);
                const d = Array.isArray(details) ? details[0] : details;
                if (d?.billingImei) {
                  blimei = d.billingImei;
                  const newBan = d.attBan || d.billingAccountNumber || null;
                  if (newBan) {
                    await supabasePatch(env, `sims?id=eq.${encodeURIComponent(String(simId))}`, { att_ban: newBan });
                    console.log(`[ImeiGatewaySync] SIM ${iccid}: backfilled att_ban=${newBan}`);
                  }
                } else {
                  results.push({ sim_id: simId, iccid, ok: false, error: "No billingImei in subscriber details" });
                  continue;
                }
              } else if (!attBan) {
                results.push({ sim_id: simId, iccid, ok: false, error: "Missing att_ban and no mobility_subscription_id" });
                continue;
              } else if (!mdn) {
                results.push({ sim_id: simId, iccid, ok: false, error: "Missing phone number (mdn)" });
                continue;
              } else {
                const otaResult = await hxOtaRefresh(
                  env, token,
                  { ban: attBan, subscriberNumber: mdn, iccid },
                  runId, iccid
                );
                blimei = extractBlimeiFromOta(otaResult);
                if (!blimei) {
                  results.push({ sim_id: simId, iccid, ok: false, error: "Could not extract BLIMEI from OTA response" });
                  continue;
                }
              }
            }

            const dbImei = sim.imei;
            // Always update sims.imei to live BLIMEI first — heartbeat uses this for retries
            if (blimei !== dbImei) {
              await supabasePatch(env, `sims?id=eq.${encodeURIComponent(String(simId))}`, { imei: blimei });
            }
            await callSkylineSetImei(env, gateway_id, port, blimei);
            await markGatewayImeiSynced(env, simId);

            results.push({ sim_id: simId, iccid, ok: true, blimei, db_imei_was: dbImei, needs_ota });
          } catch (err) {
            results.push({ sim_id: simId, ok: false, error: String(err) });
          }
        }

        const ok_count = results.filter(r => r.ok).length;
        const fail_count = results.filter(r => !r.ok).length;
        return new Response(JSON.stringify({ ok: true, ok_count, fail_count, results }, null, 2), {
          status: 200, headers: { "Content-Type": "application/json" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), {
          status: 500, headers: { "Content-Type": "application/json" }
        });
      }
    }

    if (url.pathname === "/sim-action" && request.method === "POST") {
      const secret = url.searchParams.get("secret") || "";
      if (!env.ADMIN_RUN_SECRET || secret !== env.ADMIN_RUN_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }

      try {
        const body = await request.json();
        const { sim_id, action } = body;

        if (!sim_id || !action) {
          return new Response(JSON.stringify({ error: "sim_id and action are required" }), {
            status: 400,
            headers: { "Content-Type": "application/json" }
          });
        }

        const validActions = ["ota_refresh", "cancel", "resume", "rotate", "fix", "retry_activation", "change_imei"];
        if (!validActions.includes(action)) {
          return new Response(JSON.stringify({ error: `Invalid action: ${action}. Valid: ${validActions.join(", ")}` }), {
            status: 400,
            headers: { "Content-Type": "application/json" }
          });
        }

        // Load SIM from DB
        const sims = await supabaseSelect(
          env,
          `sims?select=id,iccid,mobility_subscription_id,vendor,gateway_id,port,status,imei,activated_at,att_ban,sim_numbers(e164)&id=eq.${encodeURIComponent(String(sim_id))}&limit=1&sim_numbers.valid_to=is.null`
        );
        if (!Array.isArray(sims) || sims.length === 0) {
          return new Response(JSON.stringify({ ok: false, error: `SIM not found: ${sim_id}` }), {
            status: 404,
            headers: { "Content-Type": "application/json" }
          });
        }
        const sim = sims[0];
        const iccid = sim.iccid;
        const subId = sim.mobility_subscription_id;

        // For rotate, delegate directly
        if (action === "rotate") {
          const result = await rotateSpecificSim(env, iccid);
          return new Response(JSON.stringify({ ok: result.ok, action, sim_id, iccid, detail: result }, null, 2), {
            status: result.ok ? 200 : 500,
            headers: { "Content-Type": "application/json" }
          });
        }

        // For fix, resolve gateway/port first, then send to dedicated queue.
        if (action === "fix") {
          if (!env.FIX_SIM_QUEUE) {
            return new Response(JSON.stringify({ ok: false, error: "FIX_SIM_QUEUE binding not configured" }), {
              status: 500, headers: { "Content-Type": "application/json" }
            });
          }

          let gwId = sim.gateway_id;
          let gwPort = sim.port;

          // Manual slot provided (from slot picker modal)
          if (body.gateway_id && body.port) {
            gwId = parseInt(body.gateway_id, 10) || body.gateway_id;
            gwPort = dotPortToLetter(String(body.port)); // "13.03" → "13C"
            await supabasePatch(env, `sims?id=eq.${encodeURIComponent(String(sim_id))}`, { gateway_id: gwId, port: gwPort });
            console.log(`[SimAction/fix] SIM ${iccid}: persisted manual slot gateway_id=${gwId} port=${gwPort}`);
          } else if (!gwId || !gwPort) {
            // Auto-scan gateways for this ICCID
            console.log(`[SimAction/fix] SIM ${iccid}: no gateway/port — scanning gateways...`);
            const found = await scanGatewaysForIccid(env, iccid);
            if (found) {
              gwId = found.gateway_id;
              gwPort = found.port;
              await supabasePatch(env, `sims?id=eq.${encodeURIComponent(String(sim_id))}`, { gateway_id: gwId, port: gwPort });
              console.log(`[SimAction/fix] SIM ${iccid}: discovered gateway_id=${gwId} port=${gwPort}`);
            } else {
              return new Response(JSON.stringify({
                ok: false,
                slot_not_found: true,
                message: "SIM not found on any gateway. Please enter the slot manually.",
                sim_id, iccid
              }), { status: 200, headers: { "Content-Type": "application/json" } });
            }
          }

          await env.FIX_SIM_QUEUE.send({ sim_id, iccid });
          return new Response(JSON.stringify({
            ok: true,
            running: true,
            message: "Fix queued — check the Helix API Logs below to confirm each step completed.",
            action, sim_id, iccid
          }, null, 2), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }

        // For change_imei — full IMEI swap flow
        if (action === "change_imei") {
          const autoImei = body.auto_imei === true;
          const newImeiRaw = body.new_imei ? String(body.new_imei).trim() : null;

          if (!autoImei && (!newImeiRaw || !/^\d{15}$/.test(newImeiRaw))) {
            return new Response(JSON.stringify({ ok: false, error: "new_imei must be 15 digits, or set auto_imei: true" }), {
              status: 400, headers: { "Content-Type": "application/json" }
            });
          }
          if (!sim.gateway_id || !sim.port) {
            return new Response(JSON.stringify({ ok: false, error: "SIM must have gateway_id and port to change IMEI" }), {
              status: 400, headers: { "Content-Type": "application/json" }
            });
          }

          const isHelixSim = sim.vendor === 'helix';
          if (isHelixSim && !subId) {
            return new Response(JSON.stringify({ ok: false, error: "SIM must have mobility_subscription_id to change IMEI" }), {
              status: 400, headers: { "Content-Type": "application/json" }
            });
          }

          let hxToken = null;
          if (isHelixSim) hxToken = await getCachedToken(env);
          const changeRunId = `change_imei_${iccid}_${Date.now()}`;
          let allocatedEntry = null;
          let targetImei = newImeiRaw;

          // Retire all in_use IMEI pool entries for this SIM (by sim_id).
          // Must happen before allocating a new one — the DB unique constraint
          // (one in_use per sim_id) would otherwise block the allocation.
          await supabasePatch(
            env,
            `imei_pool?sim_id=eq.${encodeURIComponent(String(sim_id))}&status=eq.in_use`,
            { status: 'retired', sim_id: null, assigned_at: null, updated_at: new Date().toISOString() }
          );
          // Also retire any stale in_use entry occupying the same gateway/port slot.
          // This handles cases where the slot was previously assigned to a different sim_id.
          await supabasePatch(
            env,
            `imei_pool?gateway_id=eq.${encodeURIComponent(String(sim.gateway_id))}&port=eq.${encodeURIComponent(sim.port)}&status=eq.in_use`,
            { status: 'retired', sim_id: null, assigned_at: null, updated_at: new Date().toISOString() }
          );

          try {
            if (autoImei) {
              // Allocate from pool — temporarily attach to sim_id
              allocatedEntry = await allocateImeiFromPool(env, sim_id);
              targetImei = allocatedEntry.imei;
              console.log(`[ChangeImei] SIM ${iccid}: auto-allocated IMEI ${targetImei}`);
            }

            // Check IMEI eligibility (Helix only — ATOMIC has no eligibility check endpoint)
            let eligibility = { isImeiValid: true, skipped: 'non-helix vendor' };
            if (isHelixSim) {
              eligibility = await hxCheckImeiEligibility(env, hxToken, targetImei);
              if (eligibility.isImeiValid !== true) {
                if (allocatedEntry) await releaseImeiPoolEntry(env, allocatedEntry.id, sim_id).catch(() => {});
                return new Response(JSON.stringify({
                  ok: false,
                  error: `IMEI ${targetImei} is not eligible for this carrier/plan`,
                  eligibility
                }), { status: 400, headers: { "Content-Type": "application/json" } });
              }
            }

            // Set IMEI on gateway
            try {
              await callSkylineSetImei(env, sim.gateway_id, sim.port, targetImei);
            } catch (gwErr) {
              if (allocatedEntry) await releaseImeiPoolEntry(env, allocatedEntry.id, sim_id).catch(() => {});
              throw gwErr;
            }

            // Upsert new IMEI in pool as in_use for this slot
            if (!allocatedEntry) {
              // Manual IMEI: add to pool as in_use
              const upsertRes = await fetch(`${env.SUPABASE_URL}/rest/v1/imei_pool?on_conflict=imei`, {
                method: 'POST',
                headers: {
                  apikey: env.SUPABASE_SERVICE_ROLE_KEY,
                  Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
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
                console.error(`[ChangeImei] Pool upsert failed: ${upsertRes.status} ${errTxt}`);
              }
            } else {
              // Auto IMEI: update the allocated entry with gateway_id/port
              await supabasePatch(
                env,
                `imei_pool?id=eq.${encodeURIComponent(String(allocatedEntry.id))}`,
                { gateway_id: sim.gateway_id, port: sim.port, updated_at: new Date().toISOString() }
              );
            }

            // Change IMEI on carrier (Helix only — ATOMIC has no IMEI change endpoint)
            let helixResult = null;
            if (isHelixSim) {
              helixResult = await hxChangeImei(env, hxToken, subId, targetImei, changeRunId, iccid);
            }

            // Update SIM record
            await supabasePatch(env, `sims?id=eq.${encodeURIComponent(String(sim_id))}`, {
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

        // For retry_activation — handles its own SIM loading
        if (action === "retry_activation") {
          const result = await retryActivation(env, sim_id, body.gateway_id ?? null, body.port ?? null, body.imei_strategy || 'new');
          return new Response(JSON.stringify(result, null, 2), {
            status: result.ok === false && !result.slot_not_found ? 500 : 200,
            headers: { "Content-Type": "application/json" }
          });
        }

        // For ota_refresh, cancel, resume — need Helix token + mdn/ban
        if (!subId) {
          return new Response(JSON.stringify({ ok: false, error: `SIM ${iccid} has no mobility_subscription_id` }), {
            status: 400,
            headers: { "Content-Type": "application/json" }
          });
        }

        const token = await getCachedToken(env);
        const runId = `simaction_${iccid}_${Date.now()}`;

        // Use cached BAN + MDN from DB if available; fall back to subscriber_details
        // DB MDN is always preferred over Helix MDN (DB reflects post-rotation state)
        const dbMdn = sim.sim_numbers?.[0]?.e164;
        let mdn, attBan, d = null;
        if (dbMdn && sim.att_ban) {
          // Full cache hit — skip subscriber_details entirely
          mdn = String(dbMdn).replace(/\D/g, "").replace(/^1/, "");
          attBan = sim.att_ban;
          console.log(`[SimAction] SIM ${iccid}: full cache hit BAN=${attBan} MDN=${mdn}`);
        } else {
          // Need subscriber_details (att_ban not cached yet)
          const details = await hxSubscriberDetails(env, token, subId, runId, iccid);
          d = Array.isArray(details) ? details[0] : null;
          attBan = d?.attBan || d?.ban || null;
          // Sync DB with Helix details (stores att_ban, activated_at backfill, etc.)
          syncSimFromHelixDetails(env, sim, d).catch(e => console.warn(`[SyncDetails] sim_id=${sim.id}: ${e}`));
          // Prefer DB MDN (post-rotation) over Helix MDN (may be stale after rotation)
          const mdnSource = dbMdn || d?.phoneNumber;
          if (!mdnSource) {
            return new Response(JSON.stringify({ ok: false, error: `No phoneNumber for SIM ${iccid}` }), {
              status: 500,
              headers: { "Content-Type": "application/json" }
            });
          }
          mdn = String(mdnSource).replace(/\D/g, "").replace(/^1/, "");
          console.log(`[SimAction] SIM ${iccid}: using ${dbMdn ? "DB" : "Helix"} MDN=${mdn}`);
        }

        if (action === "ota_refresh") {
          if (!attBan) {
            return new Response(JSON.stringify({ ok: false, error: `No attBan for SIM ${iccid}, cannot OTA refresh` }), {
              status: 400,
              headers: { "Content-Type": "application/json" }
            });
          }
          // Sync status if Helix differs from DB
          const helixStatusMap = { Active: "active", ACTIVE: "active", ACTIVATED: "active", Suspended: "suspended", SUSPENDED: "suspended", Canceled: "canceled", CANCELED: "canceled" };
          const helixStatus = helixStatusMap[d?.status] || null;
          let statusUpdated = null;
          if (helixStatus && helixStatus !== sim.status) {
            console.log(`[OTA] SIM ${iccid}: status mismatch DB=${sim.status} Helix=${helixStatus} — updating`);
            await supabasePatch(env, `sims?id=eq.${encodeURIComponent(String(sim_id))}`, { status: helixStatus });
            statusUpdated = { from: sim.status, to: helixStatus };
          }
          let otaResult, otaError = null;
          try {
            otaResult = await hxOtaRefresh(env, token, { ban: attBan, subscriberNumber: mdn, iccid }, runId, iccid);
          } catch (otaErr) {
            if (otaErr.isSimMismatch) {
              console.log(`[OTA] SIM ${iccid}: sim number mismatch — setting status to data_mismatch`);
              await supabasePatch(env, `sims?id=eq.${encodeURIComponent(String(sim_id))}`, { status: "data_mismatch" });
              return new Response(JSON.stringify({ ok: false, action, sim_id, iccid, status_updated: { from: sim.status, to: "data_mismatch" }, error: otaErr.message }, null, 2), {
                status: 200,
                headers: { "Content-Type": "application/json" }
              });
            }
            if (otaErr.isHelixTimeout) {
              console.log(`[OTA] SIM ${iccid}: subscription not found — setting status to helix_timeout`);
              await supabasePatch(env, `sims?id=eq.${encodeURIComponent(String(sim_id))}`, { status: "helix_timeout" });
              return new Response(JSON.stringify({ ok: false, action, sim_id, iccid, status_updated: { from: sim.status, to: "helix_timeout" }, error: otaErr.message }, null, 2), {
                status: 200,
                headers: { "Content-Type": "application/json" }
              });
            }
            throw otaErr;
          }
          // Update DB based on fulfilled[0].status from OTA response
          const fulfilledStatus = otaResult && otaResult.fulfilled && otaResult.fulfilled[0] && otaResult.fulfilled[0].status;
          if (fulfilledStatus) {
            const otaStatusMap = { Active: "active", ACTIVE: "active", ACTIVATED: "active", Suspended: "suspended", SUSPENDED: "suspended", Canceled: "canceled", CANCELED: "canceled" };
            const otaDbStatus = otaStatusMap[fulfilledStatus] || null;
            const currentDbStatus = statusUpdated ? statusUpdated.to : sim.status;
            if (otaDbStatus && otaDbStatus !== currentDbStatus) {
              console.log(`[OTA] SIM ${iccid}: fulfilled=${fulfilledStatus} → updating DB ${currentDbStatus} → ${otaDbStatus}`);
              await supabasePatch(env, `sims?id=eq.${encodeURIComponent(String(sim_id))}`, { status: otaDbStatus });
              statusUpdated = { from: currentDbStatus, to: otaDbStatus };
            }
          }

          return new Response(JSON.stringify({ ok: true, action, sim_id, iccid, status_updated: statusUpdated, detail: otaResult }, null, 2), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }

        if (action === "cancel") {
          const result = await hxChangeSubscriberStatus(env, token, {
            mobilitySubscriptionId: subId,
            subscriberNumber: mdn,
            reasonCode: "CAN",
            reasonCodeId: 1,
            subscriberState: "Cancel",
          }, runId, iccid, "manual_cancel");
          await supabasePatch(env, `sims?id=eq.${encodeURIComponent(String(sim_id))}`, { status: 'canceled' });
          return new Response(JSON.stringify({ ok: true, action, sim_id, iccid, detail: result }, null, 2), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }

        if (action === "resume") {
          const result = await hxChangeSubscriberStatus(env, token, {
            mobilitySubscriptionId: subId,
            subscriberNumber: mdn,
            reasonCode: "BBL",
            reasonCodeId: 20,
            subscriberState: "Resume On Cancel",
          }, runId, iccid, "manual_resume");
          await supabasePatch(env, `sims?id=eq.${encodeURIComponent(String(sim_id))}`, { status: 'active' });
          return new Response(JSON.stringify({ ok: true, action, sim_id, iccid, detail: result }, null, 2), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
      } catch (err) {
        return new Response(JSON.stringify({ ok: false, error: String(err) }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    if (url.pathname === "/error-summary") {
      const secret = url.searchParams.get("secret") || "";
      if (!env.ADMIN_RUN_SECRET || secret !== env.ADMIN_RUN_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }

      const result = await sendErrorSummaryToSlack(env);
      return new Response(JSON.stringify(result, null, 2), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    
    if (url.pathname === "/check-imei" && request.method === "GET") {
      const secret = url.searchParams.get("secret") || "";
      if (!env.ADMIN_RUN_SECRET || secret !== env.ADMIN_RUN_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
      const imei = url.searchParams.get("imei") || "";
      if (!/^\d{15}$/.test(imei)) {
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
        // Helix token/check unavailable (ATOMIC migration) — treat as eligible
        return new Response(JSON.stringify({ ok: true, imei, eligible: true, note: 'Eligibility check unavailable: ' + String(err).slice(0, 100) }), {
          status: 200, headers: { "Content-Type": "application/json" }
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
        let token = null;
        try { token = await getCachedToken(env); } catch (_) {}
        const results = [];
        for (const rawImei of imeis) {
          const imei = String(rawImei).trim();
          if (!/^\d{15}$/.test(imei)) {
            results.push({ imei, eligible: false, error: "Invalid format (not 15 digits)" });
            continue;
          }
          if (!token) {
            results.push({ imei, eligible: true, note: 'Eligibility check unavailable (Helix token missing)' });
            continue;
          }
          try {
            const result = await hxCheckImeiEligibility(env, token, imei);
            results.push({ imei, eligible: result.isImeiValid === true, result });
          } catch (err) {
            results.push({ imei, eligible: true, note: 'Check unavailable: ' + String(err).slice(0, 100) });
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

    if (url.pathname === "/sync-gateway-slots" && request.method === "POST") {
      const secret = url.searchParams.get("secret") || "";
      if (!env.ADMIN_RUN_SECRET || secret !== env.ADMIN_RUN_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
      try {
        const gateway_id = Number(url.searchParams.get("gateway_id"));
        if (!gateway_id) {
          return new Response(JSON.stringify({ error: "gateway_id is required" }), {
            status: 400, headers: { "Content-Type": "application/json" }
          });
        }
        if (!env.SKYLINE_GATEWAY) {
          return new Response(JSON.stringify({ error: "SKYLINE_GATEWAY service binding not configured" }), {
            status: 500, headers: { "Content-Type": "application/json" }
          });
        }

        const skUrl = `https://skyline-gateway/port-info?gateway_id=${encodeURIComponent(String(gateway_id))}&all_slots=1&secret=${encodeURIComponent(env.SKYLINE_SECRET)}`;
        const skRes = await env.SKYLINE_GATEWAY.fetch(skUrl);
        if (!skRes.ok) {
          const errTxt = await skRes.text();
          return new Response(JSON.stringify({ error: `Skyline error ${skRes.status}: ${errTxt}` }), {
            status: 502, headers: { "Content-Type": "application/json" }
          });
        }
        const data = await skRes.json();

        let synced = 0, not_found = 0;
        for (const p of (data.ports || [])) {
          if (!p.iccid) continue;
          const sims = await supabaseSelect(env, `sims?select=id&iccid=eq.${encodeURIComponent(p.iccid)}&limit=1`);
          if (!Array.isArray(sims) || sims.length === 0) { not_found++; continue; }
          await supabasePatch(env, `sims?id=eq.${encodeURIComponent(String(sims[0].id))}`, { gateway_id, port: p.port });
          synced++;
        }

        return new Response(JSON.stringify({ ok: true, gateway_id, synced, not_found }, null, 2), {
          status: 200, headers: { "Content-Type": "application/json" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ ok: false, error: String(err) }), {
          status: 500, headers: { "Content-Type": "application/json" }
        });
      }
    }

return new Response("mdn-rotator ok. Use /run?secret=...&limit=1, /rotate-sim?secret=...&iccid=..., or /error-summary?secret=...", { status: 200 });
  },

  // Cron handler
  // - Every 20 min 04:00-16:00 UTC (midnight-noon EDT / 1am-1pm EST): rotation
  // - 7am UTC: error summary to Slack
  async scheduled(event, env, ctx) {
    const hour = new Date(event.scheduledTime).getUTCHours();
    // Rotation: runs every 20 min all day until all client-assigned SIMs are rotated
    ctx.waitUntil(queueSimsForRotation(env));
    // IMEI heartbeat: DISABLED — investigating gateway instability
    // ctx.waitUntil(queueImeiHeartbeats(env));
    // Error summary at 7am UTC
    if (hour === 7) {
      ctx.waitUntil(sendErrorSummaryToSlack(env));
    }
  },

  // Queue consumer - processes SIMs in batches with cached token
  // After 3 failures, records error for manual triage via /errors dashboard
  async queue(batch, env) {
    if (batch.queue === "fix-sim-queue") {
      // Each message is one fix job; batch size is 1
      for (const msg of batch.messages) {
        const { sim_id, iccid } = msg.body;
        try {
          const token = await getCachedToken(env);
          await fixSim(env, token, sim_id, { autoRotate: false });
          msg.ack();
        } catch (err) {
          console.error("[FixSimQueue] error for SIM", sim_id, err);
          const errRunId = `fixsim_err_${iccid}_${Date.now()}`;
          await logHelixApiCall(env, {
            run_id: errRunId,
            step: "fix_sim_error",
            iccid,
            request_url: "internal",
            request_method: "N/A",
            request_body: { sim_id },
            response_status: 0,
            response_ok: false,
            error: String(err),
          }).catch(() => {});
          msg.ack(); // don't retry — already logged, user can re-trigger
        }
      }
      return;
    }

    // Default: mdn-rotation-queue
    let token = null;
    try {
      token = await getCachedToken(env);
    } catch (err) {
      // Token fetch failure is non-fatal: ATOMIC/Wing SIMs don't need a Helix token.
      // If a Helix SIM reaches rotateSingleSim with token=null, the Helix code path
      // will throw — acceptable since all Helix SIMs are canceled anyway.
      console.warn(`[Queue] Helix token fetch failed (non-fatal for non-Helix SIMs): ${err}`);
    }

    for (const message of batch.messages) {
      const sim = message.body;

      // Handle IMEI heartbeat jobs: DISABLED — investigating gateway instability
      if (sim.type === "imei_heartbeat") {
        console.log(`[ImeiHeartbeat] DISABLED — skipping SIM ${sim.iccid}`);
        message.ack(); continue;
        try {
          await callSkylineSetImei(env, sim.gateway_id, sim.port, sim.imei);
          // Increment consecutive success count (capped at 3 = graduated)
          const newCount = Math.min((sim.sync_count || 0) + 1, 3);
          await supabasePatch(env, `sims?id=eq.${encodeURIComponent(String(sim.sim_id))}`, {
            gateway_imei_synced_at: new Date().toISOString(),
            gateway_imei_sync_count: newCount,
          });
          const status = newCount >= 3 ? "graduated — skipping future heartbeats" : `${newCount}/3`;
          console.log(`[ImeiHeartbeat] SIM ${sim.iccid}: IMEI synced (${status})`);
        } catch (err) {
          // Reset consecutive count — streak broken. Cron will re-enqueue next cycle.
          await supabasePatch(env, `sims?id=eq.${encodeURIComponent(String(sim.sim_id))}`, {
            gateway_imei_sync_count: 0,
          }).catch(() => {});
          console.warn(`[ImeiHeartbeat] SIM ${sim.iccid}: failed, streak reset (will retry next cron): ${err.message}`);
        }
        message.ack();
        continue;
      }

      // Handle BLIMEI update jobs: DISABLED — investigating gateway instability
      if (sim.type === "blimei_update") {
        console.log(`[BlimeiUpdate] DISABLED — skipping SIM ${sim.iccid}`);
        message.ack(); continue;
      }
      // blimei_update (dead code while disabled):
      if (sim.type === "blimei_update_disabled") {
        try {
          const rows = await supabaseSelect(
            env,
            `sims?select=id,iccid,gateway_id,port,att_ban,imei,mobility_subscription_id,sim_numbers(e164)&id=eq.${encodeURIComponent(String(sim.sim_id))}&limit=1&sim_numbers.valid_to=is.null`
          );
          if (!Array.isArray(rows) || rows.length === 0) {
            console.warn(`[BlimeiUpdate] SIM ${sim.iccid}: not found`);
            message.ack(); continue;
          }
          const s = rows[0];
          if (!s.gateway_id || !s.port) {
            console.warn(`[BlimeiUpdate] SIM ${s.iccid}: no gateway/port`);
            message.ack(); continue;
          }
          let blimei = null;
          if (!s.att_ban && s.mobility_subscription_id) {
            const details = await hxSubscriberDetails(env, token, s.mobility_subscription_id, `blimei-sweep`, s.iccid);
            const d = Array.isArray(details) ? details[0] : details;
            if (d?.billingImei) {
              blimei = d.billingImei;
              const newBan = d.attBan || d.billingAccountNumber || null;
              if (newBan) await supabasePatch(env, `sims?id=eq.${encodeURIComponent(String(s.id))}`, { att_ban: newBan }).catch(() => {});
            }
          } else if (s.att_ban) {
            const mdnRaw = Array.isArray(s.sim_numbers) && s.sim_numbers.length > 0 ? s.sim_numbers[0].e164 : null;
            const mdn = mdnRaw ? String(mdnRaw).replace(/\D/g, "").replace(/^1/, "") : null;
            if (mdn) {
              const otaResult = await hxOtaRefresh(env, token, { ban: s.att_ban, subscriberNumber: mdn, iccid: s.iccid }, `blimei-sweep`, s.iccid);
              blimei = extractBlimeiFromOta(otaResult);
            }
          }
          if (!blimei) {
            console.warn(`[BlimeiUpdate] SIM ${s.iccid}: could not get BLIMEI`);
            message.ack(); continue;
          }
          // Always update DB first so heartbeat uses correct BLIMEI even if gateway is down
          if (blimei !== s.imei) {
            await supabasePatch(env, `sims?id=eq.${encodeURIComponent(String(s.id))}`, { imei: blimei });
            console.log(`[BlimeiUpdate] SIM ${s.iccid}: DB imei updated ${s.imei} → ${blimei}`);
          }
          await callSkylineSetImei(env, s.gateway_id, s.port, blimei);
          await markGatewayImeiSynced(env, s.id);
          console.log(`[BlimeiUpdate] SIM ${s.iccid}: gateway IMEI set to ${blimei} ✓`);
        } catch (err) {
          console.warn(`[BlimeiUpdate] SIM ${sim.iccid}: ${err.message}`);
          // Don't reset heartbeat count — gateway may just be temporarily down
        }
        message.ack();
        continue;
      }

      try {
        await rotateSingleSim(env, token, sim);
        message.ack();
        console.log(`SIM ${sim.iccid}: rotation complete`);
      } catch (err) {
        console.error(`SIM ${sim.iccid} failed: ${err}`);
        await updateSimRotationError(env, sim.id, `Rotation failed: ${err}`).catch(() => {});
        message.ack();
      }

    }
  },
};

// ===========================
// Queue all SIMs for rotation (runs at 05:00 UTC or on manual trigger)
// ===========================
async function queueSimsForRotation(env, options = {}) {
  const isManualRun = options.limit && options.limit < 10000;
  const queryLimit = options.limit || 10000;

  // Build query - manual runs prioritize SIMs that were rotated longest ago
  // NULLS FIRST ensures SIMs that have never been rotated get processed first
  // !inner join on reseller_sims ensures only SIMs assigned to an active client are rotated
  // Include rotation-eligible vendors (helix, atomic). Exclude teltik (handled by
  // teltik-worker on its own 48h cadence) and wing_iot (no rotation logic yet —
  // Wing IoT SIMs are filtered out client-side via the identifier check below).
  // Identifier requirement enforced client-side: helix needs mobility_subscription_id,
  // atomic needs msisdn.
  let query = `sims?select=id,iccid,mobility_subscription_id,msisdn,vendor,status,last_mdn_rotated_at,reseller_sims!inner(reseller_id)&reseller_sims.active=eq.true&status=eq.active&vendor=neq.teltik`;

  if (isManualRun) {
    // Manual run: order by oldest rotation first (nulls first = never rotated)
    query += `&order=last_mdn_rotated_at.asc.nullsfirst&limit=${queryLimit}`;
    console.log(`[Manual Run] Fetching ${queryLimit} SIMs ordered by oldest rotation first`);
  } else {
    // Scheduled run: fetch all active SIMs (filter by today EST in JS below)
    query += `&order=id.asc&limit=${queryLimit}`;
    console.log(`[Scheduled Run] Fetching all active SIMs for EST-today filter`);
  }

  const rawSims = await supabaseSelect(env, query);

  // Per-vendor identifier filter (PostgREST OR is awkward, so filter in JS).
  // Wing IoT SIMs have no msisdn/subId in DB and fall out here — intentional
  // until Wing rotation is wired into this worker.
  const sims = (Array.isArray(rawSims) ? rawSims : []).filter(s => {
    const v = s.vendor || 'helix';
    if (v === 'helix') return !!s.mobility_subscription_id;
    if (v === 'atomic') return !!s.msisdn;
    return false;
  });

  if (sims.length === 0) {
    console.log("No active SIMs eligible for rotation (vendor/identifier filter).");
    return { ok: true, queued: 0, message: "No SIMs to rotate" };
  }

  // For scheduled runs: filter out SIMs already rotated today (NY timezone, DST-aware)
  let simsToQueue = sims;
  if (!isManualRun) {
    const todayEstISO = getNYMidnightISO();
    simsToQueue = sims.filter(s => !s.last_mdn_rotated_at || s.last_mdn_rotated_at < todayEstISO);
    console.log(`[Scheduled Run] ${sims.length} active SIMs, ${simsToQueue.length} not yet rotated since ${todayEstISO} (midnight NY), ${sims.length - simsToQueue.length} skipped`);
  }

  if (simsToQueue.length === 0) {
    console.log("All active SIMs already rotated today.");
    return { ok: true, queued: 0, message: "All SIMs already rotated today" };
  }

  console.log(`Queuing ${simsToQueue.length} SIMs for rotation...`);

  // Queue each SIM (queue operations don't count toward subrequest limit)
  const messages = simsToQueue.map(sim => ({ body: sim }));

  // Send in batches of 100 (queue API limit)
  let queued = 0;
  for (let i = 0; i < messages.length; i += 100) {
    const batch = messages.slice(i, i + 100);
    await env.MDN_QUEUE.sendBatch(batch);
    queued += batch.length;
  }

  console.log(`Queued ${queued} SIMs for rotation.`);
  return { ok: true, queued, total: sims.length, manual: isManualRun };
}

// ===========================
// IMEI Heartbeat — re-queue SIMs whose IMEI hasn't been confirmed on gateway recently
// Runs every cron cycle; capped at 100/run to avoid queue flooding
// ===========================
async function queueImeiHeartbeats(env) {
  if (!env.MDN_QUEUE) return;

  // Only queue SIMs that haven't graduated (< 3 consecutive successes).
  // Graduated SIMs (count >= 3) are skipped until suspended/canceled resets their count.
  const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  const stale = await supabaseSelect(
    env,
    `sims?select=id,iccid,gateway_id,port,imei,gateway_imei_sync_count&status=eq.active&gateway_id=not.is.null&port=not.is.null&imei=not.is.null&gateway_imei_sync_count=lt.3&or=(gateway_imei_synced_at.is.null,gateway_imei_synced_at.lt.${threeHoursAgo})&limit=100`
  ).catch(err => {
    console.warn(`[ImeiHeartbeat] Query failed: ${err}`);
    return [];
  });

  if (!Array.isArray(stale) || stale.length === 0) {
    console.log("[ImeiHeartbeat] All SIMs graduated or in sync");
    return;
  }

  const messages = stale.map(s => ({
    body: {
      type: "imei_heartbeat",
      sim_id: s.id,
      iccid: s.iccid,
      gateway_id: s.gateway_id,
      port: s.port,
      imei: s.imei,
      sync_count: s.gateway_imei_sync_count || 0,
    }
  }));
  await env.MDN_QUEUE.sendBatch(messages);
  console.log(`[ImeiHeartbeat] Queued ${messages.length} SIMs (non-graduated) for IMEI re-sync`);
}

// ===========================
// Queue all active SIMs for OTA BLIMEI update sweep
// ===========================
async function queueBlimeiUpdates(env) {
  if (!env.MDN_QUEUE) return { queued: 0, error: "MDN_QUEUE not configured" };
  const sims = await supabaseSelect(
    env,
    `sims?select=id,iccid&status=eq.active&gateway_id=not.is.null&limit=5000`
  ).catch(err => { console.warn(`[BlimeiSweep] Query failed: ${err}`); return []; });
  if (!Array.isArray(sims) || sims.length === 0) return { queued: 0 };
  // Send in batches of 100 (CF queue sendBatch limit)
  let queued = 0;
  for (let i = 0; i < sims.length; i += 100) {
    const batch = sims.slice(i, i + 100);
    await env.MDN_QUEUE.sendBatch(batch.map(s => ({
      body: { type: "blimei_update", sim_id: s.id, iccid: s.iccid }
    })));
    queued += batch.length;
  }
  console.log(`[BlimeiSweep] Queued ${queued} SIMs for BLIMEI update`);
  return { queued };
}

// ===========================
// Rotate a specific SIM by ICCID (manual trigger)
// ===========================
async function rotateSpecificSim(env, iccid) {
  try {
    // Look up the SIM by ICCID
    const sims = await supabaseSelect(
      env,
      `sims?select=id,iccid,mobility_subscription_id,msisdn,status,vendor&iccid=eq.${encodeURIComponent(iccid)}&limit=1`
    );

    if (!Array.isArray(sims) || sims.length === 0) {
      return { ok: false, error: `SIM not found with ICCID: ${iccid}` };
    }

    const sim = sims[0];
    const vendor = sim.vendor || 'helix';

    if (vendor === 'teltik') {
      return { ok: false, error: 'Use teltik-worker for Teltik SIM rotation' };
    }

    if (sim.status !== 'active') {
      return { ok: false, error: `SIM ${iccid} is not active (status: ${sim.status})` };
    }

    if (vendor === 'atomic') {
      if (!sim.msisdn) {
        return { ok: false, error: `SIM ${iccid} has no msisdn (atomic)` };
      }
      try {
        console.log(`SIM ${iccid}: starting ATOMIC rotation`);
        await rotateAtomicSim(env, sim);
        return { ok: true, iccid, message: `SIM ${iccid} rotated successfully (atomic)` };
      } catch (err) {
        console.error(`SIM ${iccid}: ATOMIC rotation failed: ${err}`);
        await updateSimRotationError(env, sim.id, `ATOMIC rotation failed: ${err}`).catch(() => {});
        return { ok: false, iccid, error: String(err) };
      }
    }

    // helix path (default)
    if (!sim.mobility_subscription_id) {
      return { ok: false, error: `SIM ${iccid} has no mobility_subscription_id` };
    }

    const token = await getCachedToken(env);

    try {
      console.log(`SIM ${iccid}: starting rotation`);
      await rotateSingleSim(env, token, sim);
      return { ok: true, iccid, message: `SIM ${iccid} rotated successfully` };
    } catch (err) {
      console.error(`SIM ${iccid}: rotation failed: ${err}`);
      await updateSimRotationError(env, sim.id, `Rotation failed: ${err}`).catch(() => {});
      return { ok: false, iccid, error: String(err) };
    }
  } catch (err) {
    console.error(`Manual rotation failed for ${iccid}: ${err}`);
    return { ok: false, iccid, error: String(err) };
  }
}

// ===========================
// Rotate a single ATOMIC SIM (swap MSISDN → subscriber inquiry → DB + webhook)
// ===========================
async function rotateAtomicSim(env, sim) {
  const iccid = sim.iccid;
  const currentMsisdn = sim.msisdn;
  const runId = `rotate_${iccid}_${Date.now()}`;

  if (!currentMsisdn) throw new Error(`SIM ${iccid}: no msisdn for ATOMIC rotation`);
  if (!env.ATOMIC_USERNAME || !env.ATOMIC_TOKEN || !env.ATOMIC_PIN) {
    throw new Error('ATOMIC credentials not configured on mdn-rotator worker');
  }

  const url = env.ATOMIC_API_URL || 'https://solutionsatt-atomic.telgoo5.com:22712';
  const session = {
    userName: env.ATOMIC_USERNAME,
    token: env.ATOMIC_TOKEN,
    pin: env.ATOMIC_PIN,
  };
  const zipCode = env.HX_ZIP || '11238';

  // 1) swapMSISDN
  const swapBody = {
    wholeSaleApi: {
      session,
      wholeSaleRequest: { requestType: 'swapMSISDN', MSISDN: currentMsisdn, zipCode },
    },
  };
  const swapRes = await relayFetch(env, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(swapBody),
  });
  const swapText = await swapRes.text();
  let swapJson = {};
  try { swapJson = JSON.parse(swapText); } catch {}
  const swapR = swapJson?.wholeSaleApi?.wholeSaleResponse;
  await logCarrierApiCall(env, {
    run_id: runId, step: 'mdn_change', iccid, imei: null, vendor: 'atomic',
    request_url: url, request_method: 'POST', request_body: swapBody,
    response_status: swapRes.status, response_ok: swapRes.ok,
    response_body_text: swapText, response_body_json: swapJson,
    error: (swapRes.ok && swapR?.statusCode === '00') ? null :
      `ATOMIC swapMSISDN failed: ${swapR?.description || swapRes.status}`,
  });
  if (!swapRes.ok) throw new Error(`ATOMIC swapMSISDN HTTP ${swapRes.status}: ${swapText.slice(0, 300)}`);
  if (swapR?.statusCode !== '00') {
    throw new Error(`ATOMIC swapMSISDN failed: ${swapR?.description || 'Unknown'}`);
  }

  // Try to read new MSISDN from swap response; fall back to inquiry by SIM
  let newMsisdn = swapR?.Result?.MSISDN || swapR?.Result?.newMSISDN || swapR?.newMSISDN || null;

  if (!newMsisdn) {
    const inqBody = {
      wholeSaleApi: {
        session,
        wholeSaleRequest: { requestType: 'subsriberInquiry', MSISDN: '', sim: iccid },
      },
    };
    const inqRes = await relayFetch(env, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(inqBody),
    });
    const inqText = await inqRes.text();
    let inqJson = {};
    try { inqJson = JSON.parse(inqText); } catch {}
    const inqR = inqJson?.wholeSaleApi?.wholeSaleResponse;
    await logCarrierApiCall(env, {
      run_id: runId, step: 'subscriber_inquiry', iccid, imei: null, vendor: 'atomic',
      request_url: url, request_method: 'POST', request_body: inqBody,
      response_status: inqRes.status, response_ok: inqRes.ok,
      response_body_text: inqText, response_body_json: inqJson,
      error: (inqRes.ok && inqR?.statusCode === '00') ? null :
        `ATOMIC inquiry failed: ${inqR?.description || inqRes.status}`,
    });
    newMsisdn = inqR?.Result?.MSISDN || null;
  }

  if (!newMsisdn) throw new Error(`ATOMIC: no new MSISDN returned after swapMSISDN`);

  const e164 = normalizeUS(newMsisdn);
  const msisdnBare = String(newMsisdn).replace(/^\+?1?/, '');

  // 2) DB updates (same sequence as Helix rotation)
  await closeCurrentNumber(env, sim.id);
  await insertNewNumber(env, sim.id, e164);
  await updateSimRotationTimestamp(env, sim.id);
  await supabasePatch(env, `sims?id=eq.${encodeURIComponent(String(sim.id))}`, { msisdn: msisdnBare });

  // 3) Webhook (use MSISDN as the external identifier, same slot as mobility_subscription_id
  //    occupies for Helix SIMs — downstream reseller systems just need *an* ID)
  await sendNumberOnlineWebhook(env, sim.id, e164, iccid, msisdnBare);

  console.log(`SIM ${iccid}: ATOMIC rotated ${currentMsisdn} → ${msisdnBare} (${e164})`);
}

// ===========================
// Rotate a single SIM (called by queue consumer)
// Each SIM uses ~7 subrequests, well under the 1000 limit
// ===========================
async function rotateSingleSim(env, token, sim) {
  const iccid = sim.iccid;
  const vendor = sim.vendor || 'helix';

  // Dedup check: skip if already rotated today (catches duplicate queue messages from multi-cron).
  // Hoisted above the vendor dispatch so it applies to every vendor uniformly.
  const todayMidnightEst = getNYMidnightISO();
  if (sim.last_mdn_rotated_at && sim.last_mdn_rotated_at >= todayMidnightEst) {
    console.log(`SIM ${iccid} (${vendor}): already rotated today (${sim.last_mdn_rotated_at}), skipping duplicate queue message`);
    return;
  }
  // Re-check current DB value (queue message may be stale from an earlier cron run)
  const freshSim = await supabaseSelectOne(env, `sims?id=eq.${encodeURIComponent(String(sim.id))}&select=last_mdn_rotated_at`);
  if (freshSim && freshSim.last_mdn_rotated_at && freshSim.last_mdn_rotated_at >= todayMidnightEst) {
    console.log(`SIM ${iccid} (${vendor}): DB confirms already rotated today (${freshSim.last_mdn_rotated_at}), skipping`);
    return;
  }

  // Vendor dispatch.
  // - atomic: delegate to rotateAtomicSim (defined elsewhere in this file)
  // - wing_iot / teltik: explicit early-return (defense-in-depth; the cron
  //   query in queueSimsForRotation already filters these out, so reaching
  //   here means a stray queue message — log loudly, do not fall through to
  //   the helix code path)
  // - helix: fall through to the original logic below (default)
  if (vendor === 'atomic') {
    return await rotateAtomicSim(env, sim);
  }
  if (vendor === 'wing_iot') {
    console.log(`SIM ${iccid}: wing_iot rotation not implemented in mdn-rotator yet — skipping (queue message should not have reached here; check queueSimsForRotation)`);
    return;
  }
  if (vendor === 'teltik') {
    console.log(`SIM ${iccid}: teltik handled by teltik-worker — skipping (queue message should not have reached here; check queueSimsForRotation)`);
    return;
  }

  // ---- Helix path (default) ----
  const subId = sim.mobility_subscription_id;
  if (!subId) {
    console.log(`SIM ${iccid}: no mobility_subscription_id, skipping`);
    return;
  }

  // Generate unique run_id for this rotation operation
  const runId = `rotate_${iccid}_${Date.now()}`;

  // 1) MDN change - request new number from carrier
  let mdnChange;
  try {
    mdnChange = await hxMdnChange(env, token, subId, runId, iccid);
  } catch (err) {
    const msg = String(err);
    // "Subscriber must be active" — comes back as 500 but is NOT transient; queue fix-sim
    // Must be checked BEFORE the generic 5xx handler or it gets silently swallowed
    if (/subscriber.*must.*be.*active/i.test(msg)) {
      console.log(`SIM ${iccid}: subscriber-must-be-active — queuing fix-sim, will retry rotation next cron run`);
      if (env.FIX_SIM_QUEUE) {
        await env.FIX_SIM_QUEUE.send({ sim_id: sim.id, iccid }).catch(e =>
          console.error(`SIM ${iccid}: failed to enqueue fix-sim: ${e}`)
        );
      }
      return;
    }
    // Helix 5xx = transient error; skip silently — next cron run will retry
    // (last_mdn_rotated_at is not updated, so this SIM stays in the rotation queue)
    if (/MDN change failed: 5\d\d/.test(msg)) {
      console.log(`SIM ${iccid}: Helix 5xx (transient), skipping — next cron run will retry`);
      return;
    }
    throw err;
  }

  // 2) Get the new phone number
  const details = await hxSubscriberDetails(env, token, subId, runId, iccid);
  const d = Array.isArray(details) ? details[0] : null;
  const phoneNumber = d?.phoneNumber;
  const detailsIccid = d?.iccid || iccid;

  // Skip rotation if Helix subscriber is already canceled
  const rotateHelixStatus = d?.status ? String(d.status).toLowerCase() : null;
  if (rotateHelixStatus === 'canceled' || rotateHelixStatus === 'cancelled') {
    console.log(`SIM ${iccid}: subscriber is CANCELED in Helix — updating DB and skipping rotation`);
    await supabasePatch(env, `sims?id=eq.${encodeURIComponent(String(sim.id))}`, { status: 'canceled' });
    return;
  }

  if (!phoneNumber) {
    throw new Error(`No phoneNumber returned for SUBID ${subId}`);
  }

  const e164 = normalizeUS(phoneNumber);

  // 3) Close current number (set valid_to timestamp)
  await closeCurrentNumber(env, sim.id);

  // 4) Insert new number (with valid_from timestamp, valid_to = null)
  await insertNewNumber(env, sim.id, e164);

  // 5) Update SIM rotation tracking
  await updateSimRotationTimestamp(env, sim.id);

  // 6) Send number.online webhook immediately
  await sendNumberOnlineWebhook(env, sim.id, e164, detailsIccid, subId);

  // 7) Re-sync gateway IMEI (guard rail against DLC suspension) — DISABLED
  // Investigating gateway instability; re-enable once root cause confirmed.
  // if (sim.gateway_id && sim.port && sim.imei) {
  //   callSkylineSetImei(env, sim.gateway_id, sim.port, sim.imei)
  //     .then(() => markGatewayImeiSynced(env, sim.id))
  //     .catch(err => console.warn(`[Rotation] SIM ${iccid}: IMEI re-sync failed (non-fatal): ${err.message}`));
  // }

  console.log(`SIM ${iccid}: rotated to ${e164}`);
}

// ===========================
// Send number.online webhook
// ===========================
async function sendNumberOnlineWebhook(env, simId, number, iccid, mobilitySubscriptionId) {
  const resellerId = await findResellerIdBySimId(env, simId);
  if (!resellerId) {
    console.log(`[Webhook] SIM ${simId}: no active reseller, skipping number.online`);
    return;
  }

  const webhookUrl = await findWebhookUrlByResellerId(env, resellerId);
  if (!webhookUrl) {
    console.log(`[Webhook] SIM ${simId}: reseller ${resellerId} has no enabled webhook, skipping number.online`);
    return;
  }

  const result = await sendWebhookWithDeduplication(env, webhookUrl, {
    event_type: "number.online",
    created_at: new Date().toISOString(),
    data: {
      sim_id: simId,
      number,
      online: true,
      online_until: nextRotationUtcISO(),
      iccid,
      mobilitySubscriptionId,
      verified: true,
    }
  }, {
    idComponents: {
      simId,
      iccid,
      number,
    },
    resellerId,
  });

  if (!result.ok) {
    console.error(`[Webhook] SIM ${simId}: number.online FAILED after ${result.attempts} attempts — will be caught by daily reseller-sync cron`);
  }

  if (result.ok) {
    try {
      await fetch(`${env.SUPABASE_URL}/rest/v1/sims?id=eq.${simId}`, {
        method: 'PATCH',
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ last_notified_at: new Date().toISOString() }),
      });
    } catch (err) {
      console.error(`[Webhook] SIM ${simId}: last_notified_at PATCH failed (non-critical): ${err}`);
    }
  }
}

// ===========================
// Helix API
// ===========================
const TOKEN_CACHE_KEY = "helix_token";
const TOKEN_TTL_SECONDS = 1800; // 30 minutes

async function getCachedToken(env) {
  // Try to get cached token from KV
  if (env.TOKEN_CACHE) {
    const cached = await env.TOKEN_CACHE.get(TOKEN_CACHE_KEY);
    if (cached) {
      console.log("Using cached Helix token");
      return cached;
    }
  }

  // Fetch new token
  console.log("Fetching new Helix token");
  const token = await hxGetBearerToken(env);

  // Cache the token in KV
  if (env.TOKEN_CACHE) {
    await env.TOKEN_CACHE.put(TOKEN_CACHE_KEY, token, { expirationTtl: TOKEN_TTL_SECONDS });
  }

  return token;
}

async function hxGetBearerToken(env) {
  const res = await relayFetch(env, env.HX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "password",
      client_id: env.HX_CLIENT_ID,
      audience: env.HX_AUDIENCE,
      username: env.HX_GRANT_USERNAME,
      password: env.HX_GRANT_PASSWORD,
    }),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error(`Token failed: ${res.status} ${JSON.stringify(json)}`);
  }
  return json.access_token;
}

async function hxMdnChange(env, token, mobilitySubscriptionId, runId, iccid) {
  const url = `${env.HX_API_BASE}/api/mobility-subscriber/ctn`;
  const method = "PATCH";
  const requestBody = { mobilitySubscriptionId };

  const res = await relayFetch(env, url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(requestBody),
  });

  const responseText = await res.text();
  let json = {};
  try {
    json = JSON.parse(responseText);
  } catch {}

  // Log the API call with correct schema columns
  await logHelixApiCall(env, {
    run_id: runId,
    step: "mdn_change",
    iccid,
    request_url: url,
    request_method: method,
    request_body: requestBody,
    response_status: res.status,
    response_ok: res.ok,
    response_body_text: responseText,
    response_body_json: json,
    error: res.ok ? null : `MDN change failed: ${res.status}`,
  });

  if (!res.ok) {
    throw new Error(`MDN change failed: ${res.status} ${JSON.stringify(json)}`);
  }
  // Check for application-level rejection (HTTP 200 with rejected[] body)
  if (json?.rejected?.length > 0) {
    const msg = json.rejected[0]?.message || JSON.stringify(json.rejected);
    throw new Error(`MDN change rejected: ${msg}`);
  }
  return json;
}

async function hxSubscriberDetails(env, token, mobilitySubscriptionId, runId, iccid) {
  const url = `${env.HX_API_BASE}/api/mobility-subscriber/details`;
  const method = "POST";
  const requestBody = { mobilitySubscriptionId };

  const res = await relayFetch(env, url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(requestBody),
  });

  const responseText = await res.text();
  let json = {};
  try {
    json = JSON.parse(responseText);
  } catch {}

  // Log the API call with correct schema columns
  await logHelixApiCall(env, {
    run_id: runId,
    step: "subscriber_details",
    iccid,
    request_url: url,
    request_method: method,
    request_body: requestBody,
    response_status: res.status,
    response_ok: res.ok,
    response_body_text: responseText,
    response_body_json: json,
    error: res.ok ? null : `Details failed: ${res.status}`,
  });

  if (!res.ok) {
    throw new Error(`Details failed: ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
}

// ===========================
// retryUntilFulfilled - retries Helix calls that return rejected/failed even on HTTP 200
// ===========================
async function retryUntilFulfilled(fn, { attempts = 3, delayMs = 5000, label = '' } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const result = await fn();
      // Check for application-level rejection (status-change responses)
      if (result?.rejected?.length > 0) {
        // "already Cancelled" — subscriber is already in the desired cancel state, treat as success
        const alreadyCancelled = result.rejected.every(r => /already cancell/i.test(r.message || ""));
        if (alreadyCancelled) {
          console.log(`[retryUntilFulfilled] ${label}: subscriber already cancelled — treating as success`);
          return result;
        }
        const msg = result.rejected[0]?.message || JSON.stringify(result.rejected);
        lastErr = new Error(`${label} rejected: ${msg}`);
        console.warn(`[retryUntilFulfilled] ${label} attempt ${i}/${attempts} rejected: ${msg}`);
      // Check for application-level failure (change-IMEI responses)
      } else if (result?.failed?.length > 0) {
        // "not needed / already assigned" means IMEI is already set — treat as success
        const alreadySet = result.failed.every(f => /not needed|already assigned billing/i.test(f.reason || ""));
        if (alreadySet) {
          console.log(`[retryUntilFulfilled] ${label}: IMEI already assigned — treating as success`);
          return result;
        }
        const msg = result.failed[0]?.reason || JSON.stringify(result.failed);
        lastErr = new Error(`${label} failed: ${msg}`);
        console.warn(`[retryUntilFulfilled] ${label} attempt ${i}/${attempts} failed: ${msg}`);
      } else {
        return result; // success
      }
    } catch (err) {
      lastErr = err;
      console.warn(`[retryUntilFulfilled] ${label} attempt ${i}/${attempts} threw: ${err}`);
    }
    if (i < attempts) await sleep(delayMs);
  }
  throw lastErr;
}

// ===========================
// Fix SIM - Cancel → Resume → New IMEI (eligibility + Helix + gateway) → OTA confirm
// ===========================
async function fixSim(env, token, simId, { autoRotate = false } = {}) {
  // Load SIM details from DB
  const sims = await supabaseSelect(
    env,
    `sims?select=id,iccid,mobility_subscription_id,gateway_id,port,slot,current_imei_pool_id,status,imei,activated_at&id=eq.${encodeURIComponent(String(simId))}&limit=1`
  );
  if (!Array.isArray(sims) || sims.length === 0) {
    throw new Error(`SIM not found: ${simId}`);
  }
  const sim = sims[0];
  const iccid = sim.iccid;
  const subId = sim.mobility_subscription_id;
  const runId = `fixsim_${iccid}_${Date.now()}`;

  if (!subId) throw new Error(`SIM ${iccid}: no mobility_subscription_id`);

  // Auto-discover gateway/port if not set on SIM record
  if (!sim.gateway_id || !sim.port) {
    console.log(`[FixSim] SIM ${iccid}: no gateway_id/port — scanning gateways...`);
    const found = await scanGatewaysForIccid(env, iccid);
    if (!found) throw new Error(`SIM ${iccid}: no gateway_id/port set and ICCID not found on any gateway`);
    sim.gateway_id = found.gateway_id;
    sim.port = found.port;
    console.log(`[FixSim] SIM ${iccid}: discovered gateway_id=${sim.gateway_id} port=${sim.port}`);
    // Persist so future operations have it
    await supabasePatch(env, `sims?id=eq.${encodeURIComponent(String(simId))}`, {
      gateway_id: sim.gateway_id,
      port: sim.port,
    });
  }

  console.log(`[FixSim] Starting for SIM ${simId} (${iccid})`);

  // Get subscriber details upfront (need mdn + attBan for cancel/resume/OTA)
  const details = await retryWithBackoff(
    () => hxSubscriberDetails(env, token, subId, runId, iccid),
    { attempts: 3, label: `subscriberDetails ${iccid}` }
  );
  const d = Array.isArray(details) ? details[0] : null;
  const subscriberNumber = d?.phoneNumber;
  const attBan = d?.attBan || d?.ban || null;

  // Sync DB with Helix details (activated_at backfill, ICCID/IMEI mismatch logging)
  syncSimFromHelixDetails(env, sim, d).catch(e => console.warn(`[SyncDetails] sim_id=${sim.id}: ${e}`));

  if (!subscriberNumber) {
    throw new Error(`SIM ${iccid}: no phoneNumber from Helix`);
  }

  const mdn = String(subscriberNumber).replace(/\D/g, "").replace(/^1/, "");

  // Step 1: Cancel
  console.log(`[FixSim] SIM ${iccid}: canceling subscriber ${mdn}`);
  await retryUntilFulfilled(
    () => hxChangeSubscriberStatus(env, token, {
      mobilitySubscriptionId: subId,
      subscriberNumber: mdn,
      reasonCode: "CAN",
      reasonCodeId: 1,
      subscriberState: "Cancel",
    }, runId, iccid, "fix_cancel"),
    { attempts: 3, delayMs: 5000, label: `cancel ${iccid}` }
  );
  await sleep(10000);

  // Step 2: Resume On Cancel
  console.log(`[FixSim] SIM ${iccid}: resuming subscriber ${mdn}`);
  await retryUntilFulfilled(
    () => hxChangeSubscriberStatus(env, token, {
      mobilitySubscriptionId: subId,
      subscriberNumber: mdn,
      reasonCode: "BBL",
      reasonCodeId: 20,
      subscriberState: "Resume On Cancel",
    }, runId, iccid, "fix_resume"),
    { attempts: 3, delayMs: 5000, label: `resume ${iccid}` }
  );
  await sleep(5000); // wait for Helix to restore subscriber

  // Step 3: Determine IMEI to use.
  // Suspended SIMs always get a fresh IMEI — the one that got them suspended is retired regardless
  // of what Helix eligibility says. For other statuses, try to reuse the existing IMEI if eligible.
  let poolEntry = null;
  let newImei = sim.imei || null;

  if (sim.status === 'suspended') {
    console.log(`[FixSim] SIM ${iccid}: status=suspended — retiring current IMEI and allocating fresh from pool`);
    newImei = null;
  } else if (newImei) {
    console.log(`[FixSim] SIM ${iccid}: checking eligibility for existing IMEI ${newImei}`);
    const existingEligibility = await hxCheckImeiEligibility(env, token, newImei).catch(() => null);
    if (existingEligibility?.isImeiValid === true) {
      console.log(`[FixSim] SIM ${iccid}: existing IMEI ${newImei} is eligible — reusing`);
    } else {
      console.log(`[FixSim] SIM ${iccid}: existing IMEI ${newImei} not eligible, allocating from pool`);
      newImei = null;
    }
  }

  if (!newImei) {
    await retireAllPoolEntriesForSim(env, simId, sim.current_imei_pool_id);
    poolEntry = await allocateImeiFromPool(env, simId);
    newImei = poolEntry.imei;
    console.log(`[FixSim] SIM ${iccid}: allocated IMEI ${newImei} (pool entry ${poolEntry.id})`);
    const eligibility = await hxCheckImeiEligibility(env, token, newImei);
    if (eligibility.isImeiValid !== true) {
      throw new Error(`IMEI ${newImei} is not eligible for this carrier/plan`);
    }
  }

  try {
    // Change IMEI on Helix (re-anchors BLIMEI even when reusing the same IMEI)
    console.log(`[FixSim] SIM ${iccid}: setting IMEI on Helix to ${newImei}`);
    let changeImeiResult = await retryUntilFulfilled(
      () => hxChangeImei(env, token, subId, newImei, runId, iccid),
      { attempts: 3, delayMs: 5000, label: `changeImei ${iccid}` }
    );

    // If Helix says "already assigned" its cache is stale vs AT&T live BLIMEI.
    // Force a fresh pool IMEI to bypass the cache and actually update AT&T.
    if (changeImeiResult?._alreadyAssigned) {
      console.log(`[FixSim] SIM ${iccid}: Helix cache stale — forcing new pool IMEI to bypass`);
      if (poolEntry) await releaseImeiPoolEntry(env, poolEntry.id, simId).catch(() => {});
      await retireAllPoolEntriesForSim(env, simId, sim.current_imei_pool_id);
      poolEntry = await allocateImeiFromPool(env, simId);
      newImei = poolEntry.imei;
      console.log(`[FixSim] SIM ${iccid}: allocated fresh IMEI ${newImei} (pool entry ${poolEntry.id})`);
      const eligibility = await hxCheckImeiEligibility(env, token, newImei);
      if (eligibility.isImeiValid !== true) {
        throw new Error(`IMEI ${newImei} is not eligible for this carrier/plan`);
      }
      changeImeiResult = await retryUntilFulfilled(
        () => hxChangeImei(env, token, subId, newImei, runId, iccid),
        { attempts: 3, delayMs: 5000, label: `changeImei-forced ${iccid}` }
      );
    }

    // Set IMEI on gateway
    await retryWithBackoff(
      () => callSkylineSetImei(env, sim.gateway_id, sim.port, newImei),
      { attempts: 3, label: `setImei ${iccid}` }
    );
    console.log(`[FixSim] SIM ${iccid}: IMEI set on gateway`);
    markGatewayImeiSynced(env, simId).catch(() => {});

    if (poolEntry) {
      // New pool entry: update with gateway/port and update SIM record
      await supabasePatch(
        env,
        `imei_pool?id=eq.${encodeURIComponent(String(poolEntry.id))}`,
        { gateway_id: sim.gateway_id, port: sim.port, updated_at: new Date().toISOString() }
      );
      await supabasePatch(
        env,
        `sims?id=eq.${encodeURIComponent(String(simId))}`,
        { imei: newImei, current_imei_pool_id: poolEntry.id }
      );
    }
    // If reusing existing IMEI, sims.imei is already correct — no DB update needed.

    // Step 4: OTA Refresh
    await sleep(2000);
    if (attBan) {
      console.log(`[FixSim] SIM ${iccid}: OTA Refresh (ban=${attBan})`);
      const otaResult = await retryWithBackoff(
        () => hxOtaRefresh(env, token, { ban: attBan, subscriberNumber: mdn, iccid }, runId, iccid),
        { attempts: 3, label: `otaRefresh ${iccid}` }
      );
      // Update DB: status from OTA fulfilled response + sims.imei from OTA BLIMEI (source of truth)
      const otaBlimei = extractBlimeiFromOta(otaResult);
      if (otaBlimei && otaBlimei !== newImei) {
        console.log(`[FixSim] SIM ${iccid}: OTA BLIMEI=${otaBlimei} differs from Helix IMEI=${newImei} — updating DB to OTA BLIMEI`);
        newImei = otaBlimei;
      }
      const otaStatusPatch = {};
      const fulfilledStatus = otaResult && otaResult.fulfilled && otaResult.fulfilled[0] && otaResult.fulfilled[0].status;
      if (fulfilledStatus) {
        const otaStatusMap = { Active: 'active', ACTIVE: 'active', ACTIVATED: 'active', Suspended: 'suspended', SUSPENDED: 'suspended', Canceled: 'canceled', CANCELED: 'canceled' };
        const otaDbStatus = otaStatusMap[fulfilledStatus] || null;
        if (otaDbStatus) {
          console.log(`[FixSim] SIM ${iccid}: OTA fulfilled=${fulfilledStatus} → updating DB status to ${otaDbStatus}`);
          otaStatusPatch.status = otaDbStatus;
        }
      }
      if (otaBlimei) {
        otaStatusPatch.imei = otaBlimei;
      }
      if (Object.keys(otaStatusPatch).length > 0) {
        await supabasePatch(env, `sims?id=eq.${encodeURIComponent(String(simId))}`, otaStatusPatch);
      }
      await sleep(3000);
    } else {
      console.log(`[FixSim] SIM ${iccid}: skipping OTA Refresh (no attBan)`);
    }

  } catch (err) {
    if (poolEntry) {
      // Rollback: release newly allocated pool entry (cancel/resume already happened, can't undo those)
      console.error(`[FixSim] SIM ${iccid}: failed in IMEI/OTA phase, rolling back pool allocation: ${err}`);
      try {
        await releaseImeiPoolEntry(env, poolEntry.id, simId);
      } catch (rollbackErr) {
        console.error(`[FixSim] SIM ${iccid}: rollback release failed: ${rollbackErr}`);
      }
    } else {
      console.error(`[FixSim] SIM ${iccid}: failed in IMEI/OTA phase: ${err}`);
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
    console.log(`[FixSim] SIM ${iccid}: re-queued for rotation`);
  }

  console.log(`[FixSim] SIM ${iccid}: fix complete (IMEI=${newImei})`);
  return { imei: newImei, pool_entry_id: poolEntry?.id ?? null };
}

// ===========================
// IMEI Pool helpers
// ===========================
function parseImeiPoolConflict(status, bodyText) {
  if (status !== 409 && status !== 422) return null;
  let parsed;
  try { parsed = JSON.parse(bodyText); } catch { return null; }
  if (parsed.code !== '23505') return null;
  const msg = parsed.message || '';
  const det = parsed.details || '';
  if (msg.includes('imei_pool_unique_in_use_sim')) {
    const m = det.match(/sim_id\)=\((\d+)\)/);
    const simPart = m ? ' (SIM #' + m[1] + ')' : '';
    return 'IMEI pool conflict: SIM' + simPart + ' already has an active (in_use) IMEI entry. ' +
           'The old entry must be retired before assigning a new one. Check the IMEI Pool tab.';
  }
  if (msg.includes('imei_pool_unique_in_use_slot')) {
    const m = det.match(/gateway_id, port\)=\(([^)]+)\)/);
    const slotPart = m ? ' (gateway/port ' + m[1] + ')' : '';
    return 'IMEI pool conflict: gateway slot' + slotPart + ' already has an active (in_use) IMEI entry. ' +
           'The existing slot entry must be retired first. Check the IMEI Pool tab.';
  }
  return 'IMEI pool unique conflict: ' + (parsed.message || bodyText.slice(0, 200));
}

async function logImeiPoolConflict(env, message, details) {
  console.error('[IMEI Pool Conflict]', message, details);
  try {
    await fetch(`${env.SUPABASE_URL}/rest/v1/system_errors`, {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        source: 'imei-pool',
        action: 'duplicate_imei_assignment',
        error_message: message,
        error_details: details || null,
        severity: 'error',
        status: 'open',
      }),
    });
  } catch (e) {
    console.error('[IMEI Pool] Failed to log conflict to system_errors:', e);
  }
}

async function allocateImeiFromPool(env, simId) {
  // Find first available IMEI
  const available = await supabaseSelect(
    env,
    `imei_pool?select=id,imei&status=eq.available&order=id.asc&limit=1`
  );
  if (!Array.isArray(available) || available.length === 0) {
    throw new Error("No available IMEIs in pool");
  }

  const entry = available[0];

  // Claim it with status filter for safety (prevents double-allocation)
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/imei_pool?id=eq.${entry.id}&status=eq.available`, {
    method: "PATCH",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      status: "in_use",
      sim_id: simId,
      assigned_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }),
  });

  const txt = await res.text();
  if (!res.ok) {
    const conflict = parseImeiPoolConflict(res.status, txt);
    if (conflict) {
      await logImeiPoolConflict(env, conflict, { sim_id: simId, pool_entry_id: entry.id, imei: entry.imei });
      throw new Error(conflict);
    }
    throw new Error(`Failed to allocate IMEI: ${res.status} ${txt}`);
  }

  const updated = JSON.parse(txt);
  if (!Array.isArray(updated) || updated.length === 0) {
    // Race condition — retry once with the next available IMEI
    console.warn(`[IMEI Pool] Race condition on entry ${entry.id}, retrying with next available`);
    const available2 = await supabaseSelect(
      env,
      `imei_pool?select=id,imei&status=eq.available&order=id.asc&limit=1`
    );
    if (!Array.isArray(available2) || available2.length === 0) {
      throw new Error("No available IMEIs in pool (retry after race condition)");
    }
    const entry2 = available2[0];
    const res2 = await fetch(`${env.SUPABASE_URL}/rest/v1/imei_pool?id=eq.${entry2.id}&status=eq.available`, {
      method: "PATCH",
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        status: "in_use",
        sim_id: simId,
        assigned_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
    });
    const txt2 = await res2.text();
    if (!res2.ok) {
      const conflict2 = parseImeiPoolConflict(res2.status, txt2);
      if (conflict2) {
        await logImeiPoolConflict(env, conflict2, { sim_id: simId, pool_entry_id: entry2.id, imei: entry2.imei });
        throw new Error(conflict2);
      }
      throw new Error(`Failed to allocate IMEI (retry): ${res2.status} ${txt2}`);
    }
    const updated2 = JSON.parse(txt2);
    if (!Array.isArray(updated2) || updated2.length === 0) {
      throw new Error("IMEI allocation race condition — failed after retry");
    }
    return updated2[0];
  }

  return updated[0];
}

async function releaseImeiPoolEntry(env, poolEntryId, simId) {
  console.log(`[IMEI Pool] Releasing entry ${poolEntryId} from SIM ${simId}`);
  await supabasePatch(
    env,
    `imei_pool?id=eq.${encodeURIComponent(String(poolEntryId))}`,
    {
      status: "available",
      sim_id: null,
      assigned_at: null,
      previous_sim_id: simId,
      updated_at: new Date().toISOString(),
    }
  );
}

async function retireAllPoolEntriesForSim(env, simId, knownPoolId) {
  // Retire the known current entry first (by current_imei_pool_id)
  if (knownPoolId) {
    await retireImeiPoolEntry(env, knownPoolId, simId);
  }
  // Also retire any orphaned in_use entries where imei_pool.sim_id = simId but
  // sims.current_imei_pool_id was never set (happens with gateway-synced SIMs).
  const query = 'imei_pool?select=id&status=eq.in_use&sim_id=eq.' +
    encodeURIComponent(String(simId)) +
    (knownPoolId ? '&id=neq.' + encodeURIComponent(String(knownPoolId)) : '');
  const orphans = await supabaseSelect(env, query);
  for (const entry of (orphans || [])) {
    console.log('[IMEI Pool] Retiring orphaned pool entry ' + entry.id + ' for SIM ' + simId);
    await retireImeiPoolEntry(env, entry.id, simId);
  }
}

// ===========================
// Helix IMEI Eligibility Check
// ===========================
async function hxCheckImeiEligibility(env, token, imei) {
  const url = `${env.HX_API_BASE}/api/plans-by-imei/${encodeURIComponent(imei)}?skuId=3&resellerId=${encodeURIComponent(env.HX_ACTIVATION_CLIENT_ID)}`;
  const method = "GET";
  const runId = `check_imei_${imei}_${Date.now()}`;

  const res = await relayFetch(env, url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
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
    error: res.ok ? null : `IMEI eligibility check failed: ${res.status}`,
  });

  // 406 = IMEI not found / not eligible; 200 = eligible with plans
  if (res.status === 406 || (res.status === 404)) {
    return { isImeiValid: false, status: res.status, raw: json };
  }

  if (!res.ok) {
    throw new Error(`IMEI eligibility check failed ${res.status}: ${responseText.slice(0, 200)}`);
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
  const url = `${env.HX_API_BASE}/api/mobility-sub-ops/imei-plan`;
  const method = "PATCH";
  const requestBody = [{ mobilitySubscriptionId, imei: newImei }];

  const res = await relayFetch(env, url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
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
    error: res.ok ? null : `Change IMEI failed: ${res.status}`,
  });

  if (!res.ok) {
    throw new Error(`Change IMEI failed ${res.status}: ${responseText.slice(0, 300)}`);
  }

  // Check that successful array is non-empty.
  // Exception: Helix returns failed["not needed / already assigned"] when the IMEI is already set —
  // treat that as a success since the billing IMEI is already correct.
  if (Array.isArray(json.successful) && json.successful.length === 0) {
    const alreadyAssigned = Array.isArray(json.failed) && json.failed.some(f =>
      /not needed|already assigned billing/i.test(f.reason || "")
    );
    if (!alreadyAssigned) {
      throw new Error(`Change IMEI: no successful items. Failed: ${JSON.stringify(json.failed)}`);
    }
    console.log(`[ChangeImei] ${iccid}: IMEI ${newImei} already set as billing IMEI (Helix cache) — flagging _alreadyAssigned`);
    return { ...json, _alreadyAssigned: true };
  }

  return json;
}

async function retireImeiPoolEntry(env, poolEntryId, simId) {
  console.log(`[IMEI Pool] Retiring entry ${poolEntryId} from SIM ${simId} (will not be reused)`);
  await supabasePatch(
    env,
    `imei_pool?id=eq.${encodeURIComponent(String(poolEntryId))}`,
    {
      status: "retired",
      sim_id: null,
      assigned_at: null,
      previous_sim_id: simId,
      updated_at: new Date().toISOString(),
    }
  );
}

// ===========================
// Skyline Gateway - Set IMEI via service binding
// ===========================
async function callSkylineSetImei(env, gatewayId, port, imei) {
  if (!env.SKYLINE_GATEWAY) {
    throw new Error("SKYLINE_GATEWAY service binding not configured");
  }
  if (!env.SKYLINE_SECRET) {
    throw new Error("SKYLINE_SECRET not configured");
  }

  const skUrl = `https://skyline-gateway/set-imei?secret=${encodeURIComponent(env.SKYLINE_SECRET)}`;

  // Retry up to 3× for transient gateway errors (502, handshake fail, connection closed on reboot)
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await env.SKYLINE_GATEWAY.fetch(skUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gateway_id: gatewayId, port, imei }),
      });

      const txt = await res.text();
      let json = {};
      try { json = JSON.parse(txt); } catch {}

      if (!res.ok || !json.ok) {
        const isTransient = res.status === 502 || /handshake failed|connection closed|connection reset/i.test(txt);
        if (isTransient && attempt < 3) {
          lastErr = new Error(`Set IMEI failed: ${res.status} ${txt}`);
          console.warn(`[SetImei] gateway_id=${gatewayId} port=${port}: transient error attempt ${attempt}/3, retrying in 5s`);
          await sleep(5000);
          continue;
        }
        throw new Error(`Set IMEI failed: ${res.status} ${txt}`);
      }

      return json;
    } catch (err) {
      const isTransient = /handshake failed|connection closed|connection reset|502/i.test(err.message);
      if (isTransient && attempt < 3) {
        lastErr = err;
        console.warn(`[SetImei] gateway_id=${gatewayId} port=${port}: transient error attempt ${attempt}/3, retrying in 5s`);
        await sleep(5000);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// Mark IMEI as confirmed on gateway hardware for a given SIM
async function markGatewayImeiSynced(env, simId) {
  await supabasePatch(
    env,
    `sims?id=eq.${encodeURIComponent(String(simId))}`,
    { gateway_imei_synced_at: new Date().toISOString() }
  ).catch(err => console.warn(`[markGatewayImeiSynced] sim_id=${simId}: ${err}`));
}

// ===========================
// Extract BLIMEI from OTA refresh response
// ===========================
function extractBlimeiFromOta(otaResult) {
  const fulfilled = Array.isArray(otaResult?.fulfilled) ? otaResult.fulfilled : [];
  for (const item of fulfilled) {
    const chars = Array.isArray(item.serviceCharacteristic) ? item.serviceCharacteristic : [];
    const entry = chars.find(c => c.name === "BLIMEI");
    if (entry?.value) return entry.value;
  }
  return null;
}

// ===========================
// Helix OTA Refresh
// ===========================
async function hxOtaRefresh(env, token, payload, runId, iccid) {
  const url = `${env.HX_API_BASE}/api/mobility-subscriber/reset-ota`;
  const method = "PATCH";
  const requestBody = [payload];

  const res = await relayFetch(env, url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(requestBody),
  });

  const responseText = await res.text();
  let json = {};
  try { json = JSON.parse(responseText); } catch {}

  await logHelixApiCall(env, {
    run_id: runId,
    step: "ota_refresh",
    iccid,
    request_url: url,
    request_method: method,
    request_body: requestBody,
    response_status: res.status,
    response_ok: res.ok,
    response_body_text: responseText,
    response_body_json: json,
    error: res.ok ? null : `OTA Refresh failed: ${res.status}`,
  });

  // Helper: check any error text (body or rejected[].message) for known patterns
  const allErrorText = [
    responseText,
    ...(Array.isArray(json.rejected) ? json.rejected.map(r => r.message || "") : []),
    json.errorMessage || "",
    json.message || "",
  ].join(" ").toLowerCase();

  if (!res.ok) {
    if (allErrorText.includes("does not belong to the user")) {
      const err = new Error(`OTA Refresh rejected: ${json.errorMessage || responseText}`);
      err.isHelixTimeout = true;
      throw err;
    }
    if (allErrorText.includes("sim number does not match")) {
      const err = new Error(`OTA Refresh rejected: ${json.errorMessage || responseText}`);
      err.isSimMismatch = true;
      throw err;
    }
    throw new Error(`OTA Refresh failed: ${res.status} ${JSON.stringify(json)}`);
  }

  // Helix sometimes returns 200 with a rejected array instead of a non-2xx status
  const rejected = Array.isArray(json.rejected) ? json.rejected : [];
  const simMismatch = rejected.find(r => r.message && r.message.toLowerCase().includes("sim number does not match"));
  if (simMismatch) {
    const err = new Error(`OTA Refresh rejected: ${simMismatch.message}`);
    err.isSimMismatch = true;
    throw err;
  }

  const subNotFound = rejected.find(r => r.message && r.message.toLowerCase().includes("does not belong to the user"));
  if (subNotFound) {
    const err = new Error(`OTA Refresh rejected: ${subNotFound.message}`);
    err.isHelixTimeout = true;
    throw err;
  }

  return json;
}

async function hxChangeSubscriberStatus(env, token, statusPayload, runId, iccid, stepName) {
  const url = `${env.HX_API_BASE}/api/mobility-subscriber/status`;
  const method = "PATCH";
  // Wrap in array if not already, and remove mobilitySubscriptionId
  const cleanPayload = Array.isArray(statusPayload) ? statusPayload : [statusPayload];
  const requestBody = cleanPayload.map(item => {
    const { mobilitySubscriptionId, ...rest } = item;
    return rest;
  });

  const res = await relayFetch(env, url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(requestBody),
  });

  const responseText = await res.text();
  let json = {};
  try {
    json = JSON.parse(responseText);
  } catch {}

  await logHelixApiCall(env, {
    run_id: runId,
    step: stepName,
    iccid,
    request_url: url,
    request_method: method,
    request_body: requestBody,
    response_status: res.status,
    response_ok: res.ok,
    response_body_text: responseText,
    response_body_json: json,
    error: res.ok ? null : `${stepName} failed: ${res.status}`,
  });

  if (!res.ok) {
    throw new Error(`${stepName} failed: ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
}

function normalizeUS(phone) {
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return phone;
}

// ===========================
// Retry Activation for error-status SIMs
// ===========================

async function hxActivate(env, token, iccid, imei) {
  const addr = pickRandomAddress();
  const url = env.HX_API_BASE + '/api/mobility-activation/activate';
  const method = "POST";
  const runId = 'retry_activate_' + iccid + '_' + Date.now();
  const requestBody = {
    clientId: Number(env.HX_ACTIVATION_CLIENT_ID),
    plan: { id: Number(env.HX_PLAN_ID) },
    BAN: String(env.HX_BAN),
    FAN: String(env.HX_FAN),
    activationType: "new_activation",
    subscriber: { firstName: "SUB", lastName: "NINE" },
    address: {
      address1: addr.address1,
      city: addr.city,
      state: addr.state,
      zipCode: addr.zipCode,
    },
    service: { iccid, imei },
  };
  const res = await relayFetch(env, url, {
    method,
    headers: { "Content-Type": "application/json", Authorization: 'Bearer ' + token },
    body: JSON.stringify(requestBody),
  });
  const responseText = await res.text();
  let json = {};
  try { json = JSON.parse(responseText); } catch {}
  await logHelixApiCall(env, {
    run_id: runId, step: "retry_activation", iccid, imei,
    request_url: url, request_method: method, request_body: requestBody,
    response_status: res.status, response_ok: res.ok,
    response_body_text: responseText, response_body_json: json,
    error: res.ok ? null : 'Activate failed: ' + res.status,
  });
  if (!res.ok) throw new Error('Activate failed ' + res.status + ': ' + responseText.slice(0, 300));
  if (json && json.mobilitySubscriptionId) return json;
  const match = responseText.match(/"mobilitySubscriptionId"\s*:\s*"?(\d+)"?/);
  if (match) return { mobilitySubscriptionId: match[1], _raw: responseText };
  throw new Error('Activate returned ' + res.status + ' but no mobilitySubscriptionId. Raw: ' + responseText.slice(0, 200));
}

function relayFetch(env, url, init) {
  if (env.RELAY_URL && env.RELAY_KEY) {
    return fetch(`${env.RELAY_URL}/${url}`, {
      ...init,
      headers: {
        ...(init?.headers || {}),
        'x-relay-key': env.RELAY_KEY,
      },
    });
  }
  return fetch(url, init);
}

async function retryActivateViaAtomic(env, iccid, imei, runId) {
  const addr = pickRandomAddress();
  const url = env.ATOMIC_API_URL || 'https://solutionsatt-atomic.telgoo5.com:22712';
  const requestBody = {
    wholeSaleApi: {
      session: {
        userName: env.ATOMIC_USERNAME,
        token: env.ATOMIC_TOKEN,
        pin: env.ATOMIC_PIN,
      },
      wholeSaleRequest: {
        requestType: 'Activate',
        partnerTransactionId: runId,
        imei,
        sim: iccid,
        eSim: 'N',
        EID: '',
        BAN: '',
        firstName: 'SUB',
        lastName: 'NINE',
        streetNumber: addr.address1.split(' ')[0],
        streetDirection: '',
        streetName: addr.address1.split(' ').slice(1).join(' '),
        zip: addr.zipCode,
        plan: 'ATTNOVOICE',
        portMdn: '',
      },
    },
  };
  const res = await relayFetch(env, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });
  const responseText = await res.text();
  let responseJson = {};
  try { responseJson = JSON.parse(responseText); } catch {}
  await logCarrierApiCall(env, {
    run_id: runId, step: 'retry_activation', iccid, imei, vendor: 'atomic',
    request_url: url, request_method: 'POST', request_body: requestBody,
    response_status: res.status, response_ok: res.ok,
    response_body_text: responseText, response_body_json: responseJson,
    error: res.ok ? null : 'ATOMIC retry activation failed: ' + res.status,
  });
  if (!res.ok) throw new Error('ATOMIC retry activation failed ' + res.status + ': ' + responseText.slice(0, 300));
  const wr914 = responseJson?.wholeSaleApi?.wholeSaleResponse;
  if (wr914?.statusCode === '914') {
    // SIM already active with another MSISDN — run subsriberInquiry to get current MDN
    const inqBody = {
      wholeSaleApi: {
        session: { userName: env.ATOMIC_USERNAME, token: env.ATOMIC_TOKEN, pin: env.ATOMIC_PIN },
        wholeSaleRequest: { requestType: 'subsriberInquiry', MSISDN: '', sim: iccid },
      },
    };
    const inqRes = await relayFetch(env, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(inqBody),
    });
    const inqText = await inqRes.text();
    let inqJson = {};
    try { inqJson = JSON.parse(inqText); } catch {}
    await logCarrierApiCall(env, {
      run_id: runId, step: 'retry_activation_914_inquiry', iccid, imei, vendor: 'atomic',
      request_url: url, request_method: 'POST', request_body: inqBody,
      response_status: inqRes.status, response_ok: inqRes.ok,
      response_body_text: inqText, response_body_json: inqJson, error: null,
    });
    const inqResult = inqJson?.wholeSaleApi?.wholeSaleResponse?.Result;
    return {
      already_active: true,
      msisdn: inqResult?.msisdn || inqResult?.MSISDN || '',
      ban: inqResult?.BAN || '',
      activationDate: inqResult?.activationDate || null,
      status: 'active',
    };
  }
  const result = responseJson?.wholeSaleApi?.wholeSaleResponse?.Result;
  if (!result?.MSISDN) throw new Error('ATOMIC activation returned no MSISDN: ' + responseText.slice(0, 300));
  return { msisdn: result.MSISDN, ban: result.BAN || '', status: 'active' };
}

async function retryActivateViaWingIot(env, iccid, runId) {
  const baseUrl = env.WING_IOT_BASE_URL || 'https://restapi19.att.com/rws/api';
  const url = baseUrl + '/v1/devices/' + encodeURIComponent(iccid);
  const auth = 'Basic ' + btoa(env.WING_IOT_USERNAME + ':' + env.WING_IOT_API_KEY);

  // Step 1: GET current status to check if plan is already set
  const getHeaders = { Authorization: auth };
  const getRes = await relayFetch(env, url, { method: 'GET', headers: getHeaders });
  const getJson = await getRes.json().catch(() => ({}));
  await logCarrierApiCall(env, {
    run_id: runId, step: 'retry_activation_check', iccid, imei: null, vendor: 'wing_iot',
    request_url: url, request_method: 'GET', request_body: null,
    response_status: getRes.status, response_ok: getRes.ok,
    response_body_text: JSON.stringify(getJson), response_body_json: getJson,
    error: getRes.ok ? null : 'Wing IoT status check failed: ' + getRes.status,
  });

  // Step 2: PUT to activate - only include plan if not already set
  const hasPlan = getJson.communicationPlan === 'Wing Tel Inc - NON ABIR SMS MO/MT US';
  const requestBody = hasPlan
    ? { status: 'Activated' }
    : { communicationPlan: 'Wing Tel Inc - NON ABIR SMS MO/MT US', status: 'Activated' };

  const headers = { Authorization: auth, 'Content-Type': 'application/json' };
  const res = await relayFetch(env, url, {
    method: 'PUT',
    headers,
    body: JSON.stringify(requestBody),
  });
  const responseText = await res.text();
  let responseJson = {};
  try { responseJson = JSON.parse(responseText); } catch {}
  await logCarrierApiCall(env, {
    run_id: runId, step: 'retry_activation', iccid, imei: null, vendor: 'wing_iot',
    request_url: url, request_method: 'PUT', request_body: requestBody,
    response_status: res.status, response_ok: res.ok,
    response_body_text: responseText, response_body_json: responseJson,
    error: res.ok ? null : 'Wing IoT retry activation failed: ' + res.status,
  });
  if (!res.ok) throw new Error('Wing IoT retry activation failed ' + res.status + ': ' + responseText.slice(0, 300));

  // Step 3: GET to verify and get MDN
  const verifyRes = await relayFetch(env, url, { method: 'GET', headers: getHeaders });
  const verifyJson = await verifyRes.json().catch(() => ({}));
  await logCarrierApiCall(env, {
    run_id: runId, step: 'retry_activation_verify', iccid, imei: null, vendor: 'wing_iot',
    request_url: url, request_method: 'GET', request_body: null,
    response_status: verifyRes.status, response_ok: verifyRes.ok,
    response_body_text: JSON.stringify(verifyJson), response_body_json: verifyJson,
    error: null,
  });

  return { msisdn: verifyJson.mdn || verifyJson.msisdn || '', status: 'active' };
}

async function logCarrierApiCall(env, logData) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return;
  const vendor = logData.vendor || 'helix';
  const payload = {
    run_id: logData.run_id,
    step: logData.step,
    iccid: logData.iccid || null,
    imei: logData.imei || null,
    vendor,
    request_url: logData.request_url,
    request_method: logData.request_method,
    request_body: logData.request_body || null,
    response_status: logData.response_status,
    response_ok: logData.response_ok,
    response_body_text: (logData.response_body_text || '').slice(0, 5000),
    response_body_json: logData.response_body_json || null,
    error: logData.error || null,
    created_at: new Date().toISOString(),
  };
  console.log('[' + vendor.toUpperCase() + ' API] ' + logData.request_method + ' ' + logData.request_url + ' -> ' + logData.response_status + ' ' + (logData.response_ok ? 'OK' : 'FAIL'));
  const res = await fetch(env.SUPABASE_URL + '/rest/v1/carrier_api_logs', {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) console.error('[Carrier Log] Supabase failed: ' + res.status);
}

// Convert port-info dot-notation ("06.01") to gateway letter format ("6A")
function dotPortToLetter(dotPort) {
  const parts = String(dotPort).split('.');
  if (parts.length !== 2) return dotPort;
  const portNum = parseInt(parts[0], 10);
  const slotNum = parseInt(parts[1], 10);
  if (isNaN(portNum) || isNaN(slotNum) || slotNum < 1) return dotPort;
  return portNum + String.fromCharCode(64 + slotNum);
}

async function scanGatewaysForIccid(env, iccid) {
  if (!env.SKYLINE_GATEWAY) throw new Error("SKYLINE_GATEWAY service binding not configured");
  if (!env.SKYLINE_SECRET) throw new Error("SKYLINE_SECRET not configured");
  const gateways = await supabaseSelect(env, 'gateways?select=id,code&order=id.asc');
  if (!Array.isArray(gateways) || gateways.length === 0) return null;
  for (const gw of gateways) {
    try {
      const skUrl = 'https://skyline-gateway/port-info?gateway_id=' + encodeURIComponent(String(gw.id)) +
        '&secret=' + encodeURIComponent(env.SKYLINE_SECRET) + '&all_slots=1';
      const res = await env.SKYLINE_GATEWAY.fetch(skUrl);
      const txt = await res.text();
      let data = {};
      try { data = JSON.parse(txt); } catch {}
      if (!data.ok || !Array.isArray(data.ports)) continue;
      const found = data.ports.find(p => p.iccid === iccid);
      if (found) return { gateway_id: gw.id, gateway_code: gw.code, port: dotPortToLetter(found.port), current_imei: found.imei || null };
    } catch (err) {
      console.warn('[scanGateways] Gateway ' + gw.id + ' error: ' + err);
    }
  }
  return null;
}

async function getUnoccupiedCandidates(env) {
  if (!env.SKYLINE_GATEWAY) throw new Error("SKYLINE_GATEWAY service binding not configured");
  if (!env.SKYLINE_SECRET) throw new Error("SKYLINE_SECRET not configured");
  const activeSims = await supabaseSelect(env, 'sims?select=iccid&status=in.(active,provisioning)&limit=5000');
  const occupied = new Set(Array.isArray(activeSims) ? activeSims.map(s => s.iccid).filter(Boolean) : []);
  const gateways = await supabaseSelect(env, 'gateways?select=id,code&order=id.asc');
  if (!Array.isArray(gateways) || gateways.length === 0) return [];
  const candidates = [];
  for (const gw of gateways) {
    try {
      const skUrl = 'https://skyline-gateway/port-info?gateway_id=' + encodeURIComponent(String(gw.id)) +
        '&secret=' + encodeURIComponent(env.SKYLINE_SECRET) + '&all_slots=1';
      const res = await env.SKYLINE_GATEWAY.fetch(skUrl);
      const txt = await res.text();
      let data = {};
      try { data = JSON.parse(txt); } catch {}
      if (!data.ok || !Array.isArray(data.ports)) continue;
      for (const p of data.ports) {
        if (p.iccid && !occupied.has(p.iccid)) {
          candidates.push({ gateway_id: gw.id, gateway_code: gw.code, port: dotPortToLetter(p.port), iccid: p.iccid, current_imei: p.imei || null });
        }
      }
    } catch (err) {
      console.warn('[getUnoccupied] Gateway ' + gw.id + ' error: ' + err);
    }
  }
  return candidates;
}

async function retryActivation(env, simId, manualGatewayId = null, manualPort = null, imeiStrategy = 'new') {
  const sims = await supabaseSelect(
    env,
    'sims?select=id,iccid,status,current_imei_pool_id,imei,vendor,gateway_id,port&id=eq.' + encodeURIComponent(String(simId)) + '&limit=1'
  );
  if (!Array.isArray(sims) || sims.length === 0) throw new Error('SIM not found: ' + simId);
  const sim = sims[0];
  if (sim.status !== 'error') throw new Error('SIM ' + sim.iccid + ' is not in error state (status: ' + sim.status + ')');
  const vendor = sim.vendor || 'helix';
  console.log('[RetryActivation] Starting for SIM ' + simId + ' (' + sim.iccid + ') vendor=' + vendor);

  const runId = 'retry_' + sim.iccid + '_' + Date.now();
  let activateResult;

  // Wing IoT doesn't need gateway/IMEI - just call the API directly
  if (vendor === 'wing_iot') {
    try {
      activateResult = await retryActivateViaWingIot(env, sim.iccid, runId);
      console.log('[RetryActivation] SIM ' + sim.iccid + ': Wing IoT activation submitted, msisdn=' + (activateResult.msisdn || 'pending'));
    } catch (err) {
      console.error('[RetryActivation] SIM ' + sim.iccid + ': Wing IoT activation failed: ' + err);
      await supabasePatch(env, 'sims?id=eq.' + encodeURIComponent(String(simId)),
        { last_activation_error: String(err) });
      throw err;
    }

    const updateData = {
      status: 'active',
      last_activation_error: null,
    };
    if (activateResult.msisdn) updateData.msisdn = activateResult.msisdn;
    await supabasePatch(env, 'sims?id=eq.' + encodeURIComponent(String(simId)), updateData);
    console.log('[RetryActivation] SIM ' + sim.iccid + ': set to active');

    return {
      ok: true,
      vendor,
      msisdn: activateResult.msisdn || null,
      message: 'Wing IoT activation complete',
    };
  }

  // For helix/atomic: need gateway slot and IMEI
  let gatewayId, port;
  if (manualGatewayId && manualPort) {
    gatewayId = manualGatewayId;
    port = manualPort;
    console.log('[RetryActivation] Using manual slot: gateway=' + gatewayId + ' port=' + port);
  } else {
    const found = await scanGatewaysForIccid(env, sim.iccid);
    if (!found) {
      if (sim.gateway_id && sim.port) {
        // Gateway scan failed but DB has a known slot — use it
        gatewayId = sim.gateway_id;
        port = sim.port;
        console.log('[RetryActivation] SIM ' + sim.iccid + ' not found on gateway scan, falling back to DB slot: gateway=' + gatewayId + ' port=' + port);
      } else {
        console.log('[RetryActivation] SIM ' + sim.iccid + ' not found on any gateway and no DB slot, returning candidates');
        const candidates = await getUnoccupiedCandidates(env);
        return { ok: false, slot_not_found: true, error: 'SIM not found on any gateway port. Manually select a slot.', candidates };
      }
    } else {
      gatewayId = found.gateway_id;
      port = found.port;
      console.log('[RetryActivation] Found SIM ' + sim.iccid + ' at gateway=' + gatewayId + ' port=' + port);
    }
  }

  await supabasePatch(env, 'sims?id=eq.' + encodeURIComponent(String(simId)), { gateway_id: gatewayId, port });

  // IMEI strategy: reuse existing or allocate new from pool
  let poolEntry;
  if (imeiStrategy === 'same') {
    if (!sim.imei) {
      throw new Error('No IMEI on SIM record — cannot reuse same IMEI. Use "New from Pool" strategy instead.');
    }
    poolEntry = { id: sim.current_imei_pool_id, imei: sim.imei };
    console.log('[RetryActivation] SIM ' + sim.iccid + ': reusing existing IMEI ' + poolEntry.imei);
  } else {
    await retireAllPoolEntriesForSim(env, simId, sim.current_imei_pool_id);
    poolEntry = await allocateImeiFromPool(env, simId);
    console.log('[RetryActivation] SIM ' + sim.iccid + ': allocated IMEI ' + poolEntry.imei + ' (pool entry ' + poolEntry.id + ')');
  }

  // Set IMEI on gateway
  try {
    await callSkylineSetImei(env, gatewayId, port, poolEntry.imei);
    console.log('[RetryActivation] SIM ' + sim.iccid + ': IMEI set on gateway');
  } catch (err) {
    console.error('[RetryActivation] SIM ' + sim.iccid + ': gateway set-IMEI failed: ' + err);
    await releaseImeiPoolEntry(env, poolEntry.id, simId).catch(() => {});
    await supabasePatch(env, 'sims?id=eq.' + encodeURIComponent(String(simId)),
      { last_activation_error: 'Gateway error: ' + err.message });
    throw err;
  }

  // Vendor-aware activation (helix or atomic)
  try {
    if (vendor === 'atomic') {
      activateResult = await retryActivateViaAtomic(env, sim.iccid, poolEntry.imei, runId);
      console.log('[RetryActivation] SIM ' + sim.iccid + ': ATOMIC activation submitted, msisdn=' + activateResult.msisdn);
    } else {
      const token = await getCachedToken(env);
      activateResult = await hxActivate(env, token, sim.iccid, poolEntry.imei);
      console.log('[RetryActivation] SIM ' + sim.iccid + ': Helix activation submitted, subId=' + activateResult.mobilitySubscriptionId);
    }
  } catch (err) {
    console.error('[RetryActivation] SIM ' + sim.iccid + ': ' + vendor + ' activation failed: ' + err);
    await retireImeiPoolEntry(env, poolEntry.id, simId).catch(() => {});
    await supabasePatch(env, 'sims?id=eq.' + encodeURIComponent(String(simId)),
      { last_activation_error: String(err), imei: poolEntry.imei, current_imei_pool_id: poolEntry.id });
    throw err;
  }

  // 914: SIM was already active — inquiry ran inside retryActivateViaAtomic, release pool + sync DB
  if (activateResult.already_active) {
    console.log('[RetryActivation] SIM ' + sim.iccid + ': already active (914) — syncing DB from inquiry');
    if (imeiStrategy !== 'same' && poolEntry.id) {
      await releaseImeiPoolEntry(env, poolEntry.id, simId).catch(() => {});
    }
    const now914 = new Date().toISOString();
    const patch914 = { status: 'active', last_activation_error: null };
    if (activateResult.activationDate) {
      const parsed = new Date(activateResult.activationDate);
      if (!isNaN(parsed.getTime())) patch914.activated_at = parsed.toISOString();
    }
    await supabasePatch(env, 'sims?id=eq.' + encodeURIComponent(String(simId)), patch914);
    if (activateResult.msisdn) {
      const e164 = '+1' + activateResult.msisdn.replace(/\D/g, '');
      await supabasePatch(env, 'sim_numbers?sim_id=eq.' + encodeURIComponent(String(simId)) + '&valid_to=is.null', { valid_to: now914 });
      await fetch(`${env.SUPABASE_URL}/rest/v1/sim_numbers`, {
        method: 'POST',
        headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates' },
        body: JSON.stringify([{ sim_id: simId, e164, valid_from: now914, verification_status: 'verified', verified_at: now914 }]),
      });
      console.log('[RetryActivation] SIM ' + sim.iccid + ': 914 sync — recorded MDN ' + e164);
    }
    return { ok: true, vendor, already_active: true, msisdn: activateResult.msisdn || null, message: 'SIM was already active — DB synced from carrier query' };
  }

  // Set SIM to provisioning (helix) or active (atomic)
  const newStatus = vendor === 'atomic' ? 'active' : 'provisioning';
  const now = new Date().toISOString();
  const updateData = {
    status: newStatus,
    last_activation_error: null,
    imei: poolEntry.imei,
    current_imei_pool_id: poolEntry.id,
    activated_at: now,
  };
  if (activateResult.mobilitySubscriptionId) updateData.mobility_subscription_id = activateResult.mobilitySubscriptionId;
  if (activateResult.msisdn) updateData.msisdn = activateResult.msisdn;
  if (activateResult.ban) updateData.att_ban = activateResult.ban;

  await supabasePatch(env, 'sims?id=eq.' + encodeURIComponent(String(simId)), updateData);
  console.log('[RetryActivation] SIM ' + sim.iccid + ': set to ' + newStatus);

  // Insert MDN into sim_numbers
  if (activateResult.msisdn) {
    const e164 = '+1' + activateResult.msisdn;
    const simNumRes = await fetch(`${env.SUPABASE_URL}/rest/v1/sim_numbers`, {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=ignore-duplicates',
      },
      body: JSON.stringify([{ sim_id: simId, e164, valid_from: now, verification_status: 'verified', verified_at: now }]),
    });
    if (!simNumRes.ok) {
      console.error('[RetryActivation] SIM ' + sim.iccid + ': sim_numbers insert failed: ' + await simNumRes.text());
    } else {
      console.log('[RetryActivation] SIM ' + sim.iccid + ': recorded MDN ' + e164 + ' in sim_numbers');
    }
  }

  return {
    ok: true,
    vendor,
    imei: poolEntry.imei,
    gateway_id: gatewayId,
    port,
    msisdn: activateResult.msisdn || null,
    message: newStatus === 'active' ? 'Activation complete' : 'Activation submitted — finalizer will complete within 5 min',
  };
}

// ===========================
// Supabase helpers
// ===========================
// Returns ISO string for midnight in New York timezone (DST-aware)
function getNYMidnightISO() {
  const now = new Date();
  const nyDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now);
  const tzPart = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', timeZoneName: 'shortOffset'
  }).formatToParts(now).find(p => p.type === 'timeZoneName')?.value ?? 'GMT-5';
  const offsetHours = -parseInt(tzPart.replace('GMT', '') || '-5');
  return new Date(`${nyDate}T${String(offsetHours).padStart(2, '0')}:00:00.000Z`).toISOString();
}

async function supabaseSelect(env, path) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method: "GET",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Supabase SELECT failed: ${res.status} ${JSON.stringify(json)}`);
  return json;
}

async function supabaseSelectOne(env, path) {
  const rows = await supabaseSelect(env, path + '&limit=1');
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function supabasePatch(env, path, bodyObj) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method: "PATCH",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(bodyObj),
  });

  const txt = await res.text();
  if (!res.ok) throw new Error(`Supabase PATCH failed: ${res.status} ${txt}`);

  // Log what was actually updated
  try {
    const data = JSON.parse(txt);
    console.log(`[DB] PATCH result: ${data.length} rows updated`);
  } catch {}
}

async function supabaseInsert(env, table, rows) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(rows),
  });

  const txt = await res.text();
  if (!res.ok) throw new Error(`Supabase INSERT failed: ${res.status} ${txt}`);

  // Log what was actually inserted
  try {
    const data = JSON.parse(txt);
    console.log(`[DB] INSERT result: ${data.length} rows inserted`);
  } catch {}
}

// ===========================
// Helix API Logging
// ===========================
async function logHelixApiCall(env, logData) {
  // Use correct schema columns for helix_api_logs table
  const logPayload = {
    run_id: logData.run_id,
    step: logData.step,
    iccid: logData.iccid || null,
    imei: logData.imei || null,
    request_url: logData.request_url,
    request_method: logData.request_method,
    request_headers: logData.request_headers || null,
    request_body: logData.request_body || null,
    response_status: logData.response_status,
    response_ok: logData.response_ok,
    response_headers: logData.response_headers || null,
    response_body_text: logData.response_body_text || null,
    response_body_json: logData.response_body_json || null,
    error: logData.error || null,
    created_at: new Date().toISOString(),
  };

  // Always log to console for Cloudflare logs
  console.log(`[Helix API] ${logData.request_method} ${logData.request_url} -> ${logData.response_status} ${logData.response_ok ? 'OK' : 'FAIL'}`);
  console.log(`[Helix API] Request: ${JSON.stringify(logData.request_body)}`);
  console.log(`[Helix API] Response: ${JSON.stringify(logData.response_body_json)}`);

  try {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/helix_api_logs`, {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(logPayload),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error(`[Helix API Log] Failed to save to Supabase: ${res.status} ${errText}`);
    } else {
      console.log(`[Helix API Log] Saved to helix_api_logs table`);
    }
  } catch (err) {
    console.error(`[Helix API Log] Exception saving to Supabase: ${err}`);
  }
}

async function closeCurrentNumber(env, simId) {
  console.log(`[DB] Closing current number for sim_id=${simId}`);
  await supabasePatch(
    env,
    `sim_numbers?sim_id=eq.${encodeURIComponent(String(simId))}&valid_to=is.null`,
    { valid_to: new Date().toISOString() }
  );
  console.log(`[DB] Closed current number for sim_id=${simId}`);
}

async function insertNewNumber(env, simId, e164) {
  console.log(`[DB] Inserting new number ${e164} for sim_id=${simId}`);
  await supabaseInsert(env, "sim_numbers", [
    {
      sim_id: simId,
      e164,
      valid_from: new Date().toISOString(),
      verification_status: 'verified',
    },
  ]);
  console.log(`[DB] Inserted new number ${e164} for sim_id=${simId}`);
}

async function updateSimRotationTimestamp(env, simId) {
  const now = new Date().toISOString();
  console.log(`[DB] Updating rotation timestamp for sim_id=${simId}`);
  await supabasePatch(
    env,
    `sims?id=eq.${encodeURIComponent(String(simId))}`,
    {
      last_mdn_rotated_at: now,
      last_rotation_at: now,
      rotation_status: 'success',
      last_rotation_error: null,
    }
  );
  console.log(`[DB] Updated rotation timestamp for sim_id=${simId}`);
}

async function updateSimRotationError(env, simId, errorMessage) {
  console.log(`[DB] Recording rotation error for sim_id=${simId}`);
  await supabasePatch(
    env,
    `sims?id=eq.${encodeURIComponent(String(simId))}`,
    {
      rotation_status: 'failed',
      last_rotation_error: errorMessage,
      last_rotation_at: new Date().toISOString(),
    }
  );
  console.log(`[DB] Recorded rotation error for sim_id=${simId}`);
}

async function findResellerIdBySimId(env, simId) {
  if (!simId) return null;
  const q = `reseller_sims?select=reseller_id&sim_id=eq.${encodeURIComponent(String(simId))}&active=eq.true&limit=1`;
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${q}`, {
    method: "GET",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return Array.isArray(data) && data[0]?.reseller_id ? data[0].reseller_id : null;
}

async function findWebhookUrlByResellerId(env, resellerId) {
  if (!resellerId) return null;
  const q = `reseller_webhooks?select=url&reseller_id=eq.${encodeURIComponent(String(resellerId))}&enabled=eq.true&limit=1`;
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${q}`, {
    method: "GET",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return Array.isArray(data) && data[0]?.url ? data[0].url : null;
}

// ===========================
// WEBHOOK UTILITIES (with deduplication and retry)
// ===========================

async function generateMessageIdAsync(components) {
  const { eventType, simId, iccid, number, from, body, timestamp } = components;

  // number.online: deduplicate per day (one send per SIM per number per UTC day).
  // Other events: deduplicate per minute (prevents double-send on retry within the same minute).
  let dedupeTs;
  if (eventType === 'number.online') {
    dedupeTs = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  } else {
    dedupeTs = timestamp
      ? new Date(Math.floor(new Date(timestamp).getTime() / 60000) * 60000).toISOString()
      : new Date(Math.floor(Date.now() / 60000) * 60000).toISOString();
  }

  const str = [eventType, simId, iccid, number, from, (body || '').slice(0, 100), dedupeTs].join('|');

  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');

  return `${eventType}_${hashHex}`;
}

async function wasWebhookDelivered(env, messageId) {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/webhook_deliveries?message_id=eq.${encodeURIComponent(messageId)}&status=eq.delivered&limit=1`,
    {
      method: 'GET',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }
  );

  if (!res.ok) return false;
  const data = await res.json();
  return Array.isArray(data) && data.length > 0;
}

async function recordWebhookDelivery(env, delivery) {
  const { messageId, eventType, resellerId, webhookUrl, payload, status, attempts, responseBody } = delivery;

  await fetch(`${env.SUPABASE_URL}/rest/v1/webhook_deliveries`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify({
      message_id: messageId,
      event_type: eventType,
      reseller_id: resellerId,
      webhook_url: webhookUrl,
      payload,
      status,
      attempts,
      last_attempt_at: new Date().toISOString(),
      delivered_at: status === 'delivered' ? new Date().toISOString() : null,
      response_body: responseBody ? String(responseBody).slice(0, 2000) : null,
    }),
  });
}

async function postWebhookWithRetry(env, url, payload, options = {}) {
  const { maxRetries = 4, initialDelayMs = 1000, messageId = 'unknown' } = options;

  let lastError = null;
  let lastStatus = 0;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      console.log(`[Webhook] Attempt ${attempt}/${maxRetries + 1} for ${messageId} to ${url}`);

      const res = await relayFetch(env, url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      lastStatus = res.status;

      const responseBody = await res.text().catch(() => '');

      if (res.ok) {
        console.log(`[Webhook] Success ${res.status} for ${messageId} after ${attempt} attempt(s)`);
        return { ok: true, status: res.status, attempts: attempt, responseBody };
      }

      if (res.status >= 400 && res.status < 500) {
        console.log(`[Webhook] Client error ${res.status} for ${messageId}: ${responseBody.slice(0, 200)}`);
        return { ok: false, status: res.status, attempts: attempt, error: `Client error: ${res.status}`, responseBody };
      }

      lastError = `Server error ${res.status}: ${responseBody.slice(0, 200)}`;
      console.log(`[Webhook] ${lastError} for ${messageId}`);

    } catch (err) {
      lastError = `Network error: ${String(err)}`;
      lastStatus = 0;
      console.log(`[Webhook] ${lastError} for ${messageId}`);
    }

    if (attempt <= maxRetries) {
      const delayMs = initialDelayMs * Math.pow(2, attempt - 1);
      console.log(`[Webhook] Retrying ${messageId} in ${delayMs}ms...`);
      await sleep(delayMs);
    }
  }

  console.log(`[Webhook] Failed ${messageId} after ${maxRetries + 1} attempts: ${lastError}`);
  return { ok: false, status: lastStatus, attempts: maxRetries + 1, error: lastError, responseBody: lastError };
}

async function sendWebhookWithDeduplication(env, webhookUrl, payload, options = {}) {
  if (!webhookUrl) {
    return { ok: false, status: 0, attempts: 0, error: 'No webhook URL' };
  }

  let messageId = options.messageId;
  if (!messageId && options.idComponents) {
    messageId = await generateMessageIdAsync({
      eventType: payload.event_type,
      ...options.idComponents,
    });
  }
  if (!messageId) {
    messageId = `${payload.event_type}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  payload.message_id = messageId;

  const alreadySent = await wasWebhookDelivered(env, messageId);
  if (alreadySent) {
    console.log(`[Webhook] Skipping duplicate ${messageId}`);
    return { ok: true, status: 200, attempts: 0, skipped: true };
  }

  const result = await postWebhookWithRetry(env, webhookUrl, payload, { messageId });

  try {
    await recordWebhookDelivery(env, {
      messageId,
      eventType: payload.event_type,
      resellerId: options.resellerId,
      webhookUrl,
      payload,
      status: result.ok ? 'delivered' : 'failed',
      attempts: result.attempts,
      responseBody: result.responseBody || null,
    });
  } catch (err) {
    console.log(`[Webhook] Failed to record delivery: ${err}`);
  }

  return result;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function retryWithBackoff(fn, { attempts = 3, initialDelayMs = 1000, label = 'operation' } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err?.status || 0;
      // Don't retry 4xx client errors
      if (status >= 400 && status < 500) throw err;
      console.warn(`[Retry] ${label} attempt ${i}/${attempts} failed: ${err}`);
      if (i < attempts) await sleep(initialDelayMs * Math.pow(2, i - 1));
    }
  }
  throw lastErr;
}

function nextRotationUtcISO() {
  // DST-aware: midnight NY = 05:00 UTC (EST) or 04:00 UTC (EDT).
  // Probe 5 AM UTC of tomorrow's calendar date — always within 1h of NY midnight,
  // which correctly reflects the offset in effect at that midnight.
  const now = new Date();
  const nyDateToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now);
  const [y, m, d] = nyDateToday.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d + 1, 5, 0, 0));
  const probeNyDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(probe);
  const tzPart = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', timeZoneName: 'shortOffset'
  }).formatToParts(probe).find(p => p.type === 'timeZoneName')?.value ?? 'GMT-5';
  const offsetHours = -parseInt(tzPart.replace('GMT', '') || '-5');
  return new Date(`${probeNyDate}T${String(offsetHours).padStart(2, '0')}:00:00.000Z`).toISOString();
}

// ===========================
// SLACK ERROR SUMMARY
// ===========================

async function sendErrorSummaryToSlack(env) {
  if (!env.SLACK_WEBHOOK_URL) {
    console.log("[Slack] No SLACK_WEBHOOK_URL configured, skipping error summary");
    return { ok: false, error: "No SLACK_WEBHOOK_URL configured" };
  }

  // Get errors from the last 24 hours
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const query = `helix_api_logs?select=iccid,step,error,response_status,request_body,created_at&or=(response_ok.eq.false,error.not.is.null)&created_at=gte.${encodeURIComponent(since)}&order=created_at.desc`;

  let errors = [];
  try {
    errors = await supabaseSelect(env, query);
  } catch (err) {
    console.error(`[Slack] Failed to fetch errors: ${err}`);
    return { ok: false, error: `Failed to fetch errors: ${err}` };
  }

  if (!Array.isArray(errors) || errors.length === 0) {
    console.log("[Slack] No errors in the last 24 hours");
    // Optionally send a success message
    if (env.SLACK_NOTIFY_SUCCESS === "true") {
      await postToSlack(env, env.SLACK_WEBHOOK_URL, {
        text: ":white_check_mark: MDN Rotator: No errors in the last 24 hours"
      });
    }
    return { ok: true, errors: 0, message: "No errors to report" };
  }

  // Deduplicate by ICCID - keep only the most recent error per SIM
  const errorsByIccid = new Map();
  for (const err of errors) {
    const iccid = err.iccid || "unknown";
    if (!errorsByIccid.has(iccid)) {
      errorsByIccid.set(iccid, err);
    }
  }

  const uniqueErrors = Array.from(errorsByIccid.values());
  console.log(`[Slack] Found ${errors.length} total errors, ${uniqueErrors.length} unique SIMs`);

  // Format Slack message
  const errorLines = uniqueErrors.slice(0, 20).map(err => {
    const subId = err.request_body?.mobilitySubscriptionId || err.request_body?.mobilitySubscriptionId || null;
    const identifier = subId ? `SUB:${subId}` : (err.iccid || "unknown");
    const step = err.step || "unknown";
    const status = err.response_status || "N/A";
    const errorMsg = (err.error || "Unknown error").slice(0, 100);
    return `• \`${identifier}\` [${step}] HTTP ${status}: ${errorMsg}`;
  });

  if (uniqueErrors.length > 20) {
    errorLines.push(`_...and ${uniqueErrors.length - 20} more SIMs with errors_`);
  }

  const slackPayload = {
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `:warning: MDN Rotator Error Summary`,
          emoji: true
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${uniqueErrors.length} SIM(s)* encountered errors in the last 24 hours:`
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: errorLines.join("\n")
        }
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `Total error events: ${errors.length} | Unique SIMs: ${uniqueErrors.length} | Generated: ${new Date().toISOString()}`
          }
        ]
      }
    ]
  };

  const result = await postToSlack(env, env.SLACK_WEBHOOK_URL, slackPayload);

  return {
    ok: result.ok,
    totalErrors: errors.length,
    uniqueSims: uniqueErrors.length,
    slackStatus: result.status
  };
}

async function postToSlack(env, webhookUrl, payload) {
  try {
    const res = await relayFetch(env, webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.error(`[Slack] Failed to post: ${res.status} ${txt}`);
      return { ok: false, status: res.status };
    }

    console.log("[Slack] Message posted successfully");
    return { ok: true, status: res.status };
  } catch (err) {
    console.error(`[Slack] Exception: ${err}`);
    return { ok: false, status: 0, error: String(err) };
  }
}
