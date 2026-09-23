import { pickNextPpuAddress, markAddressVerifyFailure } from '../shared/address-picker.mjs';
import { persistRentalFromWebhookResponse } from '../shared/persist-rental.mjs';
import { buildAtomicPortInStatusRequest } from '../shared/activation-bulk.mjs';
import { resolveMsisdn, resolveZip, buildSwapImeiRequest, isSwapSuccess, swapErrorMessage } from '../shared/sim-swap.mjs';
import { carrierFetch, webhookFetch } from '../shared/fetch-timeout.mjs';
import { sbGet, sbPatch, sbPost, sbRpc } from '../shared/supabase-rest.mjs';

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

      // DB-driven polling — processes up to `limit` SIMs inline, at concurrency=3.
      // One /run click fully drains its batch; no CF Queue dependency.
      const limit = parseInt(url.searchParams.get("limit") || "60", 10) || 60;
      const concurrency = parseInt(url.searchParams.get("concurrency") || "3", 10) || 3;
      const result = await processRotationBatch(env, { limit, concurrency });
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

      const force = url.searchParams.get("force") === "true";
      const result = await rotateSpecificSim(env, iccid, { force });
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

        const results = [];
        for (const simId of simIds) {
          try {
            const result = await fixSim(env, simId);
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

    // Invoked by details-finalizer via service binding to reconcile ATOMIC SIMs that
    // ended up in provisioning after an uncertain swapMSISDN (HTTP 5xx / network error).
    if (url.pathname === "/atomic-inquiry" && request.method === "GET") {
      const secret = url.searchParams.get("secret") || "";
      if (!env.ADMIN_RUN_SECRET || secret !== env.ADMIN_RUN_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
      const iccid = url.searchParams.get("iccid") || "";
      if (!iccid) {
        return new Response(JSON.stringify({ error: "iccid required" }), {
          status: 400, headers: { "Content-Type": "application/json" }
        });
      }
      if (!env.ATOMIC_USERNAME || !env.ATOMIC_TOKEN || !env.ATOMIC_PIN) {
        return new Response(JSON.stringify({ error: "ATOMIC credentials not configured" }), {
          status: 500, headers: { "Content-Type": "application/json" }
        });
      }
      try {
        const atomicUrl = env.ATOMIC_API_URL || 'https://solutionsatt-atomic.telgoo5.com:22712';
        const inqBody = {
          wholeSaleApi: {
            session: {
              userName: env.ATOMIC_USERNAME,
              token: env.ATOMIC_TOKEN,
              pin: env.ATOMIC_PIN,
            },
            wholeSaleRequest: { requestType: 'subsriberInquiry', MSISDN: '', sim: iccid },
          },
        };
        const runId = `finalize_atomic_${iccid}_${Date.now()}`;
        const inqRes = await relayFetch(env, atomicUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(inqBody),
        });
        const inqText = await inqRes.text();
        let inqJson = {};
        try { inqJson = JSON.parse(inqText); } catch {}
        const inqR = inqJson?.wholeSaleApi?.wholeSaleResponse;
        await logCarrierApiCall(env, {
          run_id: runId, step: 'finalize_inquiry', iccid, imei: null, vendor: 'atomic',
          request_url: atomicUrl, request_method: 'POST', request_body: inqBody,
          response_status: inqRes.status, response_ok: inqRes.ok,
          response_body_text: inqText, response_body_json: inqJson,
          error: (inqRes.ok && inqR?.statusCode === '00') ? null :
            `ATOMIC inquiry failed: ${inqR?.description || inqRes.status}`,
        });
        // subsriberInquiry returns the MDN at Result.msisdn (lowercase), not MSISDN.
        // swapMSISDN's response uses Result.newMSISDN — different shape, same API.
        // Preserve the full Result object because details-finalizer needs BAN,
        // BLIMEI/IMEI, activation date, and status fields to auto-finalize a
        // completed port-in from the carrier's source-of-truth response.
        const result = inqR?.Result || {};
        const msisdn = result.msisdn || result.MSISDN || null;
        const attStatus = result.attStatus || result.status || null;
        const ban = result.BAN || result.ban || result.attBan || result.billingAccountNumber || null;
        const imei = result.BLIMEI || result.blimei || result.billingImei || result.imei || result.IMEI || null;
        const activationDate = result.activationDate || result.activatedAt || result.activation_date || null;
        const zipCode = (result.address && (result.address.zipCode || result.address.zip)) || result.zipCode || result.zip || null;
        return new Response(JSON.stringify({
          ok: inqRes.ok && inqR?.statusCode === '00',
          http_status: inqRes.status,
          statusCode: inqR?.statusCode || null,
          description: inqR?.description || null,
          msisdn,
          attStatus,
          ban,
          imei,
          activationDate,
          zipCode,
          result,
        }, null, 2), {
          status: 200, headers: { "Content-Type": "application/json" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ ok: false, error: String(err) }), {
          status: 500, headers: { "Content-Type": "application/json" }
        });
      }
    }

    // Invoked by details-finalizer via service binding (5-min cron poll of
    // SIMs with sims.port_in_pending=true) and by the dashboard's manual
    // "Check Port Status" button. Read-only ATOMIC portinStatus lookup — per
    // the atomic-wholesale-api skill, MSISDN is the only field this
    // requestType accepts; never sends port account/PIN or subscriber data,
    // and never submits/cancels/updates a port. Does not interpret the
    // carrier's statusCode/description — callers record it as-is.
    if (url.pathname === "/atomic-portin-status" && request.method === "GET") {
      const secret = url.searchParams.get("secret") || "";
      if (!env.ADMIN_RUN_SECRET || secret !== env.ADMIN_RUN_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
      const msisdn = (url.searchParams.get("msisdn") || "").replace(/\D/g, '');
      const iccid = url.searchParams.get("iccid") || "";
      if (!/^\d{10}$/.test(msisdn)) {
        return new Response(JSON.stringify({ error: "msisdn must normalize to 10 digits" }), {
          status: 400, headers: { "Content-Type": "application/json" }
        });
      }
      if (!env.ATOMIC_USERNAME || !env.ATOMIC_TOKEN || !env.ATOMIC_PIN) {
        return new Response(JSON.stringify({ error: "ATOMIC credentials not configured" }), {
          status: 500, headers: { "Content-Type": "application/json" }
        });
      }
      const result = await lookupAtomicPortinStatus(env, { msisdn, iccid });
      return new Response(JSON.stringify(result, null, 2), {
        status: result.http_status === 0 ? 500 : 200, headers: { "Content-Type": "application/json" }
      });
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

        const validActions = ["ota_refresh", "cancel", "resume", "rotate", "fix", "change_imei", "portin_status"];
        if (!validActions.includes(action)) {
          return new Response(JSON.stringify({ error: `Invalid action: ${action}. Valid: ${validActions.join(", ")}` }), {
            status: 400,
            headers: { "Content-Type": "application/json" }
          });
        }

        // Load SIM from DB
        const sims = await sbGet(
          env,
          `sims?select=id,iccid,msisdn,mobility_subscription_id,vendor,gateway_host,gateway_id,port,status,imei,activated_at,att_ban,activation_zip,sim_numbers(e164)&id=eq.${encodeURIComponent(String(sim_id))}&limit=1&sim_numbers.valid_to=is.null`
        );
        if (!Array.isArray(sims) || sims.length === 0) {
          return new Response(JSON.stringify({ ok: false, error: `SIM not found: ${sim_id}` }), {
            status: 404,
            headers: { "Content-Type": "application/json" }
          });
        }
        const sim = sims[0];
        const iccid = sim.iccid;

        // Manual, read-only ATOMIC portinStatus check — dashboard's "Check
        // Port-In Status" button. Same lookup the finalizer's periodic poll
        // uses; also records the result on the SIM row so a manual check
        // updates what the dashboard displays, not just carrier_api_logs.
        if (action === "portin_status") {
          if (sim.vendor !== "atomic") {
            return new Response(JSON.stringify({ ok: false, error: `portin_status is only supported for ATOMIC SIMs (this SIM is ${sim.vendor})` }), {
              status: 400, headers: { "Content-Type": "application/json" }
            });
          }
          const msisdn = String(sim.msisdn || '').replace(/\D/g, '');
          if (!/^\d{10}$/.test(msisdn)) {
            return new Response(JSON.stringify({ ok: false, error: "SIM has no valid 10-digit MSISDN on file to check" }), {
              status: 400, headers: { "Content-Type": "application/json" }
            });
          }
          if (!env.ATOMIC_USERNAME || !env.ATOMIC_TOKEN || !env.ATOMIC_PIN) {
            return new Response(JSON.stringify({ ok: false, error: "ATOMIC credentials not configured" }), {
              status: 500, headers: { "Content-Type": "application/json" }
            });
          }
          const lookup = await lookupAtomicPortinStatus(env, { msisdn, iccid });
          await sbPatch(env, `sims?id=eq.${encodeURIComponent(String(sim_id))}`, {
            atomic_portin_status_code: lookup.statusCode ?? null,
            atomic_portin_description: lookup.description ?? null,
            atomic_portin_checked_at: new Date().toISOString(),
          }, { logRows: true });
          return new Response(JSON.stringify({
            ok: lookup.ok, action, sim_id, iccid, status_updated: true, detail: lookup,
          }, null, 2), {
            status: lookup.http_status && lookup.http_status !== 0 ? 200 : 500,
            headers: { "Content-Type": "application/json" }
          });
        }

        // For rotate, delegate directly. `force: true` bypasses the daily dedup guard.
        if (action === "rotate") {
          const force = body.force === true;
          const result = await rotateSpecificSim(env, iccid, { force });
          return new Response(JSON.stringify({ ok: result.ok, action, sim_id, iccid, forced: force, detail: result }, null, 2), {
            status: result.ok ? 200 : 500,
            headers: { "Content-Type": "application/json" }
          });
        }

        // For fix, send to the dedicated queue (fixSim is ATOMIC-only).
        if (action === "fix") {
          if (!env.FIX_SIM_QUEUE) {
            return new Response(JSON.stringify({ ok: false, error: "FIX_SIM_QUEUE binding not configured" }), {
              status: 500, headers: { "Content-Type": "application/json" }
            });
          }

          await env.FIX_SIM_QUEUE.send({ sim_id, iccid });
          return new Response(JSON.stringify({
            ok: true,
            running: true,
            message: "Fix queued — check the carrier API logs to confirm each step completed.",
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

          // Every live SIM is Teltik-hosted (no Skyline gateway to write the modem
          // IMEI to), so the change is the carrier-side ATOMIC swapImei only.
          return changeImeiTeltikHosted(env, sim, sim_id, iccid, autoImei, newImeiRaw);
        }

        // ATOMIC OTA: resendOtaProfile takes MSISDN + ICCID; no mobility_subscription_id involved.
        if (action === "ota_refresh" && sim.vendor === "atomic") {
          if (!env.ATOMIC_USERNAME || !env.ATOMIC_TOKEN || !env.ATOMIC_PIN) {
            return new Response(JSON.stringify({ ok: false, error: "ATOMIC credentials not configured" }), {
              status: 500, headers: { "Content-Type": "application/json" }
            });
          }
          const mdnSource = sim.sim_numbers?.[0]?.e164 || sim.msisdn || null;
          if (!mdnSource) {
            return new Response(JSON.stringify({ ok: false, error: `No MSISDN for ATOMIC SIM ${iccid}, cannot OTA refresh` }), {
              status: 400, headers: { "Content-Type": "application/json" }
            });
          }
          const msisdn = String(mdnSource).replace(/\D/g, "").replace(/^1/, "");
          const atomicUrl = env.ATOMIC_API_URL || 'https://solutionsatt-atomic.telgoo5.com:22712';
          const otaRunId = `simaction_atomic_ota_${iccid}_${Date.now()}`;
          const otaBody = {
            wholeSaleApi: {
              session: { userName: env.ATOMIC_USERNAME, token: env.ATOMIC_TOKEN, pin: env.ATOMIC_PIN },
              wholeSaleRequest: { requestType: 'resendOtaProfile', MSISDN: msisdn, sim: iccid },
            },
          };
          const otaRes = await relayFetch(env, atomicUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(otaBody),
          });
          const otaText = await otaRes.text();
          let otaJson = {};
          try { otaJson = JSON.parse(otaText); } catch {}
          const otaR = otaJson?.wholeSaleApi?.wholeSaleResponse;
          const otaOk = otaRes.ok && otaR?.statusCode === '00';
          await logCarrierApiCall(env, {
            run_id: otaRunId, step: 'ota_refresh', iccid, imei: null, vendor: 'atomic',
            request_url: atomicUrl, request_method: 'POST', request_body: otaBody,
            response_status: otaRes.status, response_ok: otaRes.ok,
            response_body_text: otaText, response_body_json: otaJson,
            error: otaOk ? null : `ATOMIC OTA failed: ${otaR?.description || otaRes.status}`,
          });
          return new Response(JSON.stringify({
            ok: otaOk, action, sim_id, iccid,
            description: otaR?.description || null,
            detail: otaJson,
          }, null, 2), {
            status: 200, headers: { "Content-Type": "application/json" }
          });
        }

        // ATOMIC cancel/resume: deactivateSubscriber / reconnectSubscriber by MSISDN.
        if ((action === "cancel" || action === "resume") && sim.vendor === "atomic") {
          if (!env.ATOMIC_USERNAME || !env.ATOMIC_TOKEN || !env.ATOMIC_PIN) {
            return new Response(JSON.stringify({ ok: false, error: "ATOMIC credentials not configured" }), {
              status: 500, headers: { "Content-Type": "application/json" }
            });
          }
          const mdnSource = sim.sim_numbers?.[0]?.e164 || sim.msisdn || null;
          if (!mdnSource) {
            return new Response(JSON.stringify({ ok: false, error: `No MSISDN for ATOMIC SIM ${iccid}, cannot ${action}` }), {
              status: 400, headers: { "Content-Type": "application/json" }
            });
          }
          const msisdn = String(mdnSource).replace(/\D/g, "").replace(/^1/, "");
          const isCancel = action === "cancel";
          const requestType = isCancel ? 'deactivateSubscriber' : 'reconnectSubscriber';
          // DD = Deactivate Default; reconnect uses blank reasonCode per ATOMIC spec.
          const reasonCode = isCancel ? 'DD' : '';
          const newDbStatus = isCancel ? 'canceled' : 'active';
          const stepName = isCancel ? 'manual_cancel' : 'manual_resume';
          const atomicUrl = env.ATOMIC_API_URL || 'https://solutionsatt-atomic.telgoo5.com:22712';
          const actRunId = `simaction_atomic_${action}_${iccid}_${Date.now()}`;
          const actBody = {
            wholeSaleApi: {
              session: { userName: env.ATOMIC_USERNAME, token: env.ATOMIC_TOKEN, pin: env.ATOMIC_PIN },
              wholeSaleRequest: { requestType, MSISDN: msisdn, reasonCode },
            },
          };
          const actRes = await relayFetch(env, atomicUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(actBody),
          });
          const actText = await actRes.text();
          let actJson = {};
          try { actJson = JSON.parse(actText); } catch {}
          const actR = actJson?.wholeSaleApi?.wholeSaleResponse;
          const actOk = actRes.ok && actR?.statusCode === '00';
          await logCarrierApiCall(env, {
            run_id: actRunId, step: stepName, iccid, imei: null, vendor: 'atomic',
            request_url: atomicUrl, request_method: 'POST', request_body: actBody,
            response_status: actRes.status, response_ok: actRes.ok,
            response_body_text: actText, response_body_json: actJson,
            error: actOk ? null : `ATOMIC ${requestType} failed: ${actR?.description || actRes.status}`,
          });
          if (actOk) {
            await sbPatch(env, `sims?id=eq.${encodeURIComponent(String(sim_id))}`, { status: newDbStatus }, { logRows: true });
          }
          return new Response(JSON.stringify({
            ok: actOk, action, sim_id, iccid,
            description: actR?.description || null,
            detail: actJson,
          }, null, 2), {
            status: 200, headers: { "Content-Type": "application/json" }
          });
        }

        // ota_refresh / cancel / resume exist only for ATOMIC (handled above).
        return new Response(JSON.stringify({
          ok: false,
          error: `Action "${action}" is not supported for vendor "${sim.vendor}". Only ATOMIC exposes this endpoint.`,
        }), { status: 400, headers: { "Content-Type": "application/json" } });
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

    
return new Response("mdn-rotator ok. Use /run?secret=...&limit=1, /rotate-sim?secret=...&iccid=..., or /error-summary?secret=...", { status: 200 });
  },

  // Cron handler
  // - Rotation runs ONLY 12:00-08:59 America/New_York (DST-aware via Intl).
  //   UTC cron fires wider than that; the gate below is the source of truth.
  // - 7am UTC: error summary to Slack (always runs, regardless of window).
  async scheduled(event, env, ctx) {
    const hour = new Date(event.scheduledTime).getUTCHours();
    if (isInsideRotationWindowNY()) {
      // DB-driven polling: processRotationBatch runs inline (no CF Queue).
      // Pace is operator-tunable via ROTATE_TICK_LIMIT / ROTATE_TICK_CONCURRENCY
      // vars so ramping is a config edit (speed-up approved 2026-06-12 — finish
      // the fleet early in the window instead of trickling until ~8:30am NY).
      // Defaults 100 @ 6 ≈ 12.5 min worst case, inside the 15-min scheduled cap.
      const limit = Math.max(1, parseInt(env.ROTATE_TICK_LIMIT || '100', 10) || 100);
      const concurrency = Math.max(1, parseInt(env.ROTATE_TICK_CONCURRENCY || '6', 10) || 6);
      ctx.waitUntil(processRotationBatch(env, { limit, concurrency }));
    } else {
      console.log(`[Cron] outside NY rotation window (0-8); NY hour=${getNYHour()} — skipping rotation`);
    }
    // Error summary at 7am UTC
    if (hour === 7) {
      ctx.waitUntil(sendErrorSummaryToSlack(env));
    }
  },

  // Queue consumer: fix-sim-queue jobs and mdn-rotation-queue rotations.
  async queue(batch, env) {
    if (batch.queue === "fix-sim-queue") {
      // Each message is one fix job; batch size is 1
      for (const msg of batch.messages) {
        const { sim_id, iccid } = msg.body;
        try {
          await fixSim(env, sim_id);
          msg.ack();
        } catch (err) {
          console.error("[FixSimQueue] error for SIM", sim_id, err);
          const errRunId = `fixsim_err_${iccid}_${Date.now()}`;
          await logCarrierApiCall(env, {
            vendor: "atomic",
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

    // Default: mdn-rotation-queue (ATOMIC rotation, one SIM per message)
    for (const message of batch.messages) {
      const sim = message.body;
      try {
        await rotateSingleSim(env, sim);
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
// Bounded-concurrency runner: up to `concurrency` workers pull items from a
// shared cursor. Exceptions are caught per-item so one bad SIM doesn't abort
// the batch. Used by processRotationBatch — safe because claim_rotation_slot
// is the atomic gate preventing any two workers from claiming the same SIM.
// ===========================
async function runWithConcurrency(items, concurrency, workerFn) {
  let idx = 0;
  const results = new Array(items.length);
  async function worker() {
    while (true) {
      const my = idx++;
      if (my >= items.length) return;
      try {
        results[my] = await workerFn(items[my], my);
      } catch (e) {
        results[my] = { error: String(e) };
      }
    }
  }
  const n = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

// ===========================
// Process a single batch of eligible SIMs inline — replaces the CF Queue path.
// Pulls up to `limit` SIMs pre-filtered in SQL, then claims + rotates each
// (via rotateSingleSim which dispatches to the vendor function). Runs
// `concurrency` rotations in parallel; claim_rotation_slot is the atomic gate.
// ===========================
async function processRotationBatch(env, options = {}) {
  const limit = options.limit || 60;
  const concurrency = options.concurrency || 3;
  const todayNy = getNYMidnightISO();

  // Pre-filter eligible SIMs. Over-fetch 2x since some may be filtered out in JS.
  const query =
    `sims?select=id,iccid,mobility_subscription_id,msisdn,vendor,status,last_mdn_rotated_at,activated_at,activation_zip,rotation_eligible,canary_apex_ppu,reseller_sims!inner(reseller_id)` +
    `&reseller_sims.active=eq.true` +
    `&status=eq.active` +
    `&rotation_eligible=eq.true` +
    `&vendor=eq.atomic` +
    `&order=last_mdn_rotated_at.asc.nullsfirst` +
    `&limit=${limit * 2}`;
  const raw = await sbGet(env, query);
  const candidates = (Array.isArray(raw) ? raw : []).filter(s => {
    if (s.last_mdn_rotated_at && s.last_mdn_rotated_at >= todayNy) return false;
    if (s.activated_at && s.activated_at >= todayNy) return false;
    return !!s.msisdn;
  }).slice(0, limit);

  if (candidates.length === 0) {
    console.log('[ProcessBatch] no eligible SIMs');
    return { ok: true, attempted: 0, ok_count: 0, skipped: 0, failed: 0 };
  }

  let ok = 0, skipped = 0, failed = 0;
  // Outage circuit breaker: 8 CONSECUTIVE transport-level failures (relay
  // 5xx/530, timeouts, network errors) stop the batch — remaining SIMs are
  // left for the next 20-min tick instead of burning claims against a down
  // vendor (the 2026-05-25 relay outage logged 12,150 failed calls under the
  // old always-keep-going behavior). Per-SIM application errors (zip
  // rejected, data mismatch) do NOT count. Added with the concurrency
  // speed-up; restore-on-failure still un-stamps pre-swap throws as before.
  const BATCH_BREAKER_THRESHOLD = 8;
  let consecutiveTransportFails = 0;
  let breakerTripped = false;
  let skippedBreaker = 0;
  const isTransportErr = (msg) =>
    /\b5\d\d\b|timeout|timed out|network|fetch failed|TypeError|ECONN|socket/i.test(String(msg || ''));

  await runWithConcurrency(candidates, concurrency, async (sim) => {
    if (breakerTripped) { skippedBreaker++; return; }
    try {
      const result = await rotateSingleSim(env, sim);
      if (result && result.skipped) { skipped++; return; }
      ok++;
      consecutiveTransportFails = 0;
    } catch (err) {
      failed++;
      console.error(`[ProcessBatch] SIM ${sim.iccid} failed: ${err}`);
      await updateSimRotationError(env, sim.id, `Rotation failed: ${err}`).catch(() => {});
      if (isTransportErr(err)) {
        if (++consecutiveTransportFails >= BATCH_BREAKER_THRESHOLD) {
          breakerTripped = true;
          console.error(`[ProcessBatch] circuit breaker: ${BATCH_BREAKER_THRESHOLD} consecutive transport failures — deferring remaining SIMs to next tick`);
        }
      } else {
        consecutiveTransportFails = 0;
      }
    }
  });

  console.log(`[ProcessBatch] attempted=${candidates.length} ok=${ok} skipped=${skipped} failed=${failed} skipped_breaker=${skippedBreaker}`);
  return { ok: true, attempted: candidates.length, ok_count: ok, skipped, failed, skipped_breaker: skippedBreaker, breaker_tripped: breakerTripped };
}

// ===========================
// Rotate a specific SIM by ICCID (manual trigger)
// ===========================
async function rotateSpecificSim(env, iccid, options = {}) {
  const force = options.force === true;
  try {
    // Look up the SIM by ICCID
    const sims = await sbGet(
      env,
      `sims?select=id,iccid,mobility_subscription_id,msisdn,status,vendor,activation_zip,last_mdn_rotated_at,canary_apex_ppu&iccid=eq.${encodeURIComponent(iccid)}&limit=1`
    );

    if (!Array.isArray(sims) || sims.length === 0) {
      return { ok: false, error: `SIM not found with ICCID: ${iccid}` };
    }

    const sim = sims[0];
    const vendor = sim.vendor;

    if (vendor === 'teltik') {
      return { ok: false, error: 'Use teltik-worker for Teltik SIM rotation' };
    }

    // Daily dedup guard — applies to all vendors on manual rotate.
    // Skipped when force=true (user explicitly requested force-rotate with a confirmation warning).
    if (!force) {
      const todayMidnightEst = getNYMidnightISO();
      if (sim.last_mdn_rotated_at && sim.last_mdn_rotated_at >= todayMidnightEst) {
        return { ok: false, error: `SIM ${iccid} already rotated today (${sim.last_mdn_rotated_at}) — pass force=true to rotate again` };
      }
    }

    if (sim.status !== 'active' && sim.status !== 'rotation_failed') {
      return { ok: false, error: `SIM ${iccid} is not active (status: ${sim.status})` };
    }

    if (vendor === 'atomic') {
      if (!sim.msisdn) {
        return { ok: false, error: `SIM ${iccid} has no msisdn (atomic)` };
      }
      try {
        console.log(`SIM ${iccid}: starting ATOMIC rotation${force ? ' (force=true)' : ''}`);
        const result = await rotateAtomicSim(env, sim, { force });
        if (result && result.skipped) {
          return { ok: false, iccid, error: `SIM ${iccid} not eligible for rotation (claim_rotation_slot=false) — pass force=true to override` };
        }
        return { ok: true, iccid, message: `SIM ${iccid} rotated successfully (atomic)` };
      } catch (err) {
        console.error(`SIM ${iccid}: ATOMIC rotation failed: ${err}`);
        await updateSimRotationError(env, sim.id, `ATOMIC rotation failed: ${err}`).catch(() => {});
        return { ok: false, iccid, error: String(err) };
      }
    }

    return { ok: false, error: `SIM ${iccid}: rotation is only supported for ATOMIC SIMs (vendor ${vendor})` };
  } catch (err) {
    console.error(`Manual rotation failed for ${iccid}: ${err}`);
    return { ok: false, iccid, error: String(err) };
  }
}

// Issues ATOMIC UpdateSubscriberInfo. Throws on non-'00' statusCode or
// network error. Returns the parsed response on success.
async function atomicUpdateSubscriberInfo(env, { session, msisdn, address }, runId, iccid) {
  const url = env.ATOMIC_API_URL || 'https://solutionsatt-atomic.telgoo5.com:22712';
  const body = {
    wholeSaleApi: {
      session,
      wholeSaleRequest: {
        requestType: 'UpdateSubscriberInfo',
        MSISDN:    msisdn,
        firstName: 'EZ',
        lastName:  'Biz',
        address: {
          streetNumber:    address.streetNumber,
          streetName:      address.streetName,
          streetDirection: address.streetDirection || '',
          zipCode:         address.zipCode,
        },
      },
    },
  };
  const res = await relayFetch(env, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch {}
  const r = json?.wholeSaleApi?.wholeSaleResponse;
  await logCarrierApiCall(env, {
    run_id: runId, step: 'ppu_update', iccid, imei: null, vendor: 'atomic',
    request_url: url, request_method: 'POST', request_body: body,
    response_status: res.status, response_ok: res.ok,
    response_body_text: text, response_body_json: json,
    error: (res.ok && r?.statusCode === '00') ? null
         : `ATOMIC UpdateSubscriberInfo failed: ${r?.description || res.status}`,
  });
  if (!res.ok || r?.statusCode !== '00') {
    throw new Error(`ATOMIC UpdateSubscriberInfo failed: ${r?.description || res.status}`);
  }
  return r;
}

// ===========================
// Rotate a single ATOMIC SIM (swap MSISDN → subscriber inquiry → DB + webhook)
// opts.force=true bypasses the 24h interval guard (manual operator override).
// ===========================
async function rotateAtomicSim(env, sim, opts = {}) {
  const iccid = sim.iccid;
  const runId = `rotate_${iccid}_${Date.now()}`;
  const force = opts.force === true;

  // sim_numbers is the source of truth — every dashboard/webhook/finalizer
  // reads from there. sims.msisdn is a denormalized mirror that can drift on
  // partial-failure paths, so prefer sim_numbers.e164 (valid_to IS NULL) and
  // fall back to sim.msisdn only if no current row exists.
  const curNumRows = await sbGet(
    env,
    `sim_numbers?sim_id=eq.${encodeURIComponent(String(sim.id))}&valid_to=is.null&select=e164&limit=1`,
  ).catch(() => []);
  const curE164 = Array.isArray(curNumRows) && curNumRows[0]?.e164 ? String(curNumRows[0].e164) : null;
  const curBare = curE164 ? curE164.replace(/^\+?1?/, '') : null;
  let currentMsisdn = curBare || sim.msisdn;
  if (curBare && sim.msisdn && curBare !== sim.msisdn) {
    console.log(`SIM ${iccid}: sims.msisdn=${sim.msisdn} drift vs sim_numbers.e164=${curE164}; using sim_numbers and healing sims.msisdn`);
    await sbPatch(env, `sims?id=eq.${encodeURIComponent(String(sim.id))}`, { msisdn: curBare }, { logRows: true }).catch(() => {});
  }

  if (!currentMsisdn) throw new Error(`SIM ${iccid}: no msisdn for ATOMIC rotation`);
  if (!env.ATOMIC_USERNAME || !env.ATOMIC_TOKEN || !env.ATOMIC_PIN) {
    throw new Error('ATOMIC credentials not configured on mdn-rotator worker');
  }

  // Atomic dedup: claim_rotation_slot stamps last_mdn_rotated_at +
  // rotation_status='rotating' + rotation_source in one UPDATE. If it returns
  // false we MUST NOT call swapMSISDN — would burn an extra MDN.
  const claimed = await claimRotationSlot(env, sim.id, force);
  if (!claimed) {
    console.log(`SIM ${iccid}: atomic claim_rotation_slot=false — skipping`);
    return { skipped: true };
  }
  if (force) console.log(`SIM ${iccid}: atomic force=true — claimed with interval bypass`);

  // Cadence-stamp safety: claim_rotation_slot stamped last_mdn_rotated_at (dedup
  // lock). Any failure BEFORE swapMSISDN succeeds means no MDN was consumed, so we
  // restore this prior value before throwing (otherwise a transient failure — e.g.
  // relay 530 at the pre-swap inquiry — locks the SIM out of rotation for the day).
  // After swapMSISDN returns statusCode '00' the MDN IS changed; we must NOT restore.
  const priorRotatedAt = sim.last_mdn_rotated_at ?? null;
  const restoreRotationStamp = () =>
    sbPatch(env, `sims?id=eq.${encodeURIComponent(String(sim.id))}`, {
      last_mdn_rotated_at: priorRotatedAt,
    }, { logRows: true }).catch(() => {});

  const url = env.ATOMIC_API_URL || 'https://solutionsatt-atomic.telgoo5.com:22712';
  const session = {
    userName: env.ATOMIC_USERNAME,
    token: env.ATOMIC_TOKEN,
    pin: env.ATOMIC_PIN,
  };

  // 1) subsriberInquiry — get address zip directly from AT&T before swapMSISDN
  const preInqBody = {
    wholeSaleApi: {
      session,
      wholeSaleRequest: { requestType: 'subsriberInquiry', MSISDN: '', sim: iccid },
    },
  };
  // A timeout or network error here happens before any swap, so no MDN was used:
  // restore the claim stamp and throw a transport error so processBatch counts it
  // toward the outage breaker and moves on to the next SIM.
  let preInqRes, preInqText, preInqJson = {}, preInqNetworkError = null;
  try {
    preInqRes = await relayFetch(env, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(preInqBody),
    });
    preInqText = await preInqRes.text();
    try { preInqJson = JSON.parse(preInqText); } catch {}
  } catch (err) {
    preInqNetworkError = err;
    preInqText = String(err);
  }
  const preInqR = preInqJson?.wholeSaleApi?.wholeSaleResponse;
  await logCarrierApiCall(env, {
    run_id: runId, step: 'pre_swap_inquiry', iccid, imei: null, vendor: 'atomic',
    request_url: url, request_method: 'POST', request_body: preInqBody,
    response_status: preInqRes?.status ?? 0, response_ok: preInqRes?.ok ?? false,
    response_body_text: preInqText || '', response_body_json: preInqJson,
    error: preInqNetworkError ? `ATOMIC pre-swap inquiry network error: ${preInqNetworkError}`
      : (preInqRes.ok && preInqR?.statusCode === '00') ? null
      : `ATOMIC pre-swap inquiry failed: ${preInqR?.description || preInqRes.status}`,
  });
  if (preInqNetworkError) {
    await restoreRotationStamp();
    throw new Error(`ATOMIC pre-swap inquiry network error: ${String(preInqNetworkError).slice(0, 300)}`);
  }
  if (!preInqRes.ok || preInqR?.statusCode !== '00') {
    await restoreRotationStamp();
    throw new Error(`ATOMIC pre-swap inquiry failed: ${preInqR?.description || preInqRes.status}`);
  }

  const currentZip   = preInqR.Result?.address?.zipCode || sim.activation_zip || null;
  const currentState = preInqR.Result?.address?.state || null;

  // Sync zip to DB if AT&T has a different value
  if (preInqR.Result?.address?.zipCode && preInqR.Result.address.zipCode !== sim.activation_zip) {
    await sbPatch(env, `sims?id=eq.${encodeURIComponent(String(sim.id))}`, {
      activation_zip: preInqR.Result.address.zipCode,
    }, { logRows: true }).catch(() => {});
    console.log(`SIM ${iccid}: updated activation_zip ${sim.activation_zip} → ${preInqR.Result.address.zipCode}`);
  }

  // Self-heal DB↔carrier desync: AT&T's live MDN is the source of truth. If a
  // prior swapMSISDN committed at AT&T but our DB kept the old number, the
  // inquiry returns a DIFFERENT (Active) MDN. Adopt it as the swap-from so this
  // rotation swaps from the live number instead of a dead one ("sim/MSISDN is
  // Inactive"). Only writes msisdn (never last_mdn_rotated_at), so a later
  // restoreRotationStamp() leaves the corrected number in place — AT&T's truth.
  const attMdnBare = preInqR.Result?.msisdn
    ? String(preInqR.Result.msisdn).replace(/^\+?1?/, '')
    : (preInqR.Result?.MSISDN ? String(preInqR.Result.MSISDN).replace(/^\+?1?/, '') : null);
  if (attMdnBare && attMdnBare !== currentMsisdn) {
    // No attStatus gate: AT&T's MSISDN is what swapMSISDN/ppu_update look up
    // by, so even a Cancelled/Suspended subscriber's number is the right value
    // to send. INC-5: SIM 1067 returned attStatus=Cancelled and the gated
    // self-heal silently skipped, leaving the stale DB number in the request.
    console.log(`SIM ${iccid}: DESYNC detected — DB msisdn=${currentMsisdn} but AT&T MDN=${attMdnBare} (attStatus=${preInqR.Result?.attStatus || 'n/a'}); adopting AT&T number as swap-from`);
    currentMsisdn = attMdnBare;
    await sbPatch(env, `sims?id=eq.${encodeURIComponent(String(sim.id))}`, { msisdn: attMdnBare }, { logRows: true }).catch(() => {});
  }

  // Apex flow: pick a new PPU address (different state + zip) and update
  // AT&T's PPU before swapMSISDN. Per ATOMIC API Rule #5 (2026-05-20), swap
  // will be rejected if zipCode doesn't match the subscriber's current PPU.
  // Gated by env flag + per-SIM canary column during rollout.
  const apexEnabled = String(env.APEX_PPU_THEN_MDN_ENABLED || '').toLowerCase() === 'true';
  const canaryOnly  = String(env.APEX_PPU_CANARY_ONLY || 'true').toLowerCase() === 'true';
  const useApexFlow = apexEnabled && (!canaryOnly || sim.canary_apex_ppu === true);

  let zipCode;
  let ppuAddr = null;  // the pool address whose zip is currently set as PPU (apex flow only)
  if (useApexFlow) {
    // Up to 3 PPU attempts: first try excludes current state+zip so the new MDN
    // lands in a different area; retries drop exclusions and just take the next
    // LRU pool entry. Each AT&T verify rejection quarantines the address for 90d.
    // If all attempts fail, restore last_mdn_rotated_at to its pre-claim value so
    // the next cron tick re-attempts this SIM — otherwise claim_rotation_slot's
    // "< NY midnight" gate locks the SIM out until tomorrow night.
    const MAX_PPU_ATTEMPTS = 3;
    let ppuSuccessAddr = null;
    let lastPpuErr = null;
    const triedAddrIds = new Set();
    for (let attempt = 1; attempt <= MAX_PPU_ATTEMPTS; attempt++) {
      const pickOpts = (attempt === 1)
        ? { excludeState: currentState, excludeZip: currentZip }
        : {};
      let newAddr;
      try {
        newAddr = await pickNextPpuAddress(env, pickOpts);
      } catch (pickErr) {
        lastPpuErr = pickErr;
        break;
      }
      if (triedAddrIds.has(newAddr.id)) break;
      triedAddrIds.add(newAddr.id);
      console.log(`SIM ${iccid}: apex flow attempt ${attempt}/${MAX_PPU_ATTEMPTS} — picked PPU ${newAddr.id} (${newAddr.state} ${newAddr.zipCode})`);
      try {
        await atomicUpdateSubscriberInfo(env, {
          session, msisdn: currentMsisdn, address: newAddr,
        }, runId, iccid);
        ppuSuccessAddr = newAddr;
        break;
      } catch (ppuErr) {
        await markAddressVerifyFailure(env, newAddr.id, String(ppuErr));
        lastPpuErr = ppuErr;
        console.log(`SIM ${iccid}: PPU attempt ${attempt} verify failed — trying another address`);
      }
    }
    if (!ppuSuccessAddr) {
      await restoreRotationStamp();
      throw lastPpuErr || new Error(`SIM ${iccid}: PPU exhausted ${MAX_PPU_ATTEMPTS} attempts`);
    }
    zipCode = ppuSuccessAddr.zipCode;
    ppuAddr = ppuSuccessAddr;
    await sbPatch(env, `sims?id=eq.${encodeURIComponent(String(sim.id))}`, {
      activation_zip: ppuSuccessAddr.zipCode,
    }, { logRows: true }).catch(() => {});
  } else {
    zipCode = currentZip || env.HX_ZIP || '11238';
  }

  // 2) swapMSISDN — retried with a fresh PPU zip if AT&T rejects the current one.
  // A "zipCode Not Supported" rejection means the swap did NOT happen (no MDN was
  // assigned), so it is safe to quarantine that pool address, push a new PPU
  // (different state/zip), and retry. Bounded so a streak of bad zips can't loop.
  const MAX_SWAP_ATTEMPTS = useApexFlow ? 3 : 1;
  let swapR = null;
  for (let swapAttempt = 1; swapAttempt <= MAX_SWAP_ATTEMPTS; swapAttempt++) {
    const swapBody = {
      wholeSaleApi: {
        session,
        wholeSaleRequest: { requestType: 'swapMSISDN', MSISDN: currentMsisdn, zipCode },
      },
    };
    let swapRes, swapText, swapJson = {}, swapNetworkError = null;
    try {
      swapRes = await relayFetch(env, url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(swapBody),
      });
      swapText = await swapRes.text();
      try { swapJson = JSON.parse(swapText); } catch {}
    } catch (err) {
      swapNetworkError = err;
      swapText = String(err);
    }
    swapR = swapJson?.wholeSaleApi?.wholeSaleResponse;
    await logCarrierApiCall(env, {
      run_id: runId, step: 'mdn_change', iccid, imei: null, vendor: 'atomic',
      request_url: url, request_method: 'POST', request_body: swapBody,
      response_status: swapRes?.status ?? 0, response_ok: swapRes?.ok ?? false,
      response_body_text: swapText || '', response_body_json: swapJson,
      error: swapNetworkError ? `ATOMIC swapMSISDN network error: ${swapNetworkError}`
        : (swapRes.ok && swapR?.statusCode === '00') ? null
        : `ATOMIC swapMSISDN failed: ${swapR?.description || swapRes.status}`,
    });

    // Network error or 5xx from ATOMIC/relay: the swap may have succeeded at ATOMIC's
    // side even though we didn't get a response. DO NOT fail the rotation — flip to
    // provisioning so runAtomicFinalizer reconciles via subsriberInquiry on its next
    // 5-min tick. Observed 2026-04-24: HTTP 504 caused 3-strikes failure while ATOMIC
    // had actually assigned the new MDN, leaving DB stuck with stale msisdn.
    if (swapNetworkError || (swapRes && swapRes.status >= 500)) {
      console.log(`SIM ${iccid}: ATOMIC swap uncertain (${swapNetworkError ? 'network' : swapRes.status}) — flipping to provisioning for finalizer reconciliation`);
      await sbPatch(env, `sims?id=eq.${encodeURIComponent(String(sim.id))}`, {
        rotation_status: 'mdn_pending',
        status: 'provisioning',
        last_rotation_error: swapNetworkError ? `swap uncertain: ${String(swapNetworkError).slice(0, 300)}` : `swap uncertain: HTTP ${swapRes.status}`,
        rotation_fail_count: 0,
      }, { logRows: true });
      return;
    }
    if (!swapRes.ok) {
      await restoreRotationStamp();
      throw new Error(`ATOMIC swapMSISDN HTTP ${swapRes.status}: ${swapText.slice(0, 300)}`);
    }
    if (swapR?.statusCode === '00') break;  // swap succeeded

    const desc = swapR?.description || 'Unknown';

    // Cingular rejected the PPU zip ("zipCode Not Supported"): the address passed the
    // verify step but cannot host an MDN. Quarantine it, push a fresh PPU from the
    // pool, and retry the swap with the new zip (no MDN was burned on this attempt).
    if (useApexFlow && ppuAddr && swapAttempt < MAX_SWAP_ATTEMPTS &&
        /zip\s*code not supported|not support the zipcode/i.test(desc)) {
      console.log(`SIM ${iccid}: swap rejected zip ${zipCode} ("${desc}") — quarantining PPU ${ppuAddr.id}, re-picking from pool`);
      await markAddressVerifyFailure(env, ppuAddr.id, `swap zipCode not supported: ${desc}`);
      let nextAddr = null;
      try {
        nextAddr = await pickNextPpuAddress(env, { excludeState: ppuAddr.state, excludeZip: ppuAddr.zipCode });
        await atomicUpdateSubscriberInfo(env, { session, msisdn: currentMsisdn, address: nextAddr }, runId, iccid);
      } catch (reErr) {
        if (nextAddr?.id) await markAddressVerifyFailure(env, nextAddr.id, String(reErr));
        await restoreRotationStamp();
        throw new Error(`SIM ${iccid}: re-PPU after zip rejection failed: ${reErr}`);
      }
      ppuAddr = nextAddr;
      zipCode = nextAddr.zipCode;
      await sbPatch(env, `sims?id=eq.${encodeURIComponent(String(sim.id))}`, {
        activation_zip: nextAddr.zipCode,
      }, { logRows: true }).catch(() => {});
      continue;  // retry swapMSISDN with the replacement zip
    }

    if (/subscriber.*must.*be.*active|not.*active|status is not active/i.test(desc)) {
      console.log(`SIM ${iccid}: ATOMIC subscriber not active (statusCode ${swapR?.statusCode}) — marking suspended + queuing fix-sim`);
      // Reflect reality: AT&T says the subscriber is not active, so DB should show suspended.
      // fix-sim will run restoreSubscriber to bring it back to active.
      await sbPatch(env, `sims?id=eq.${encodeURIComponent(String(sim.id))}`, {
        status: 'suspended',
      }, { logRows: true }).catch(e => console.error(`SIM ${iccid}: failed to patch status=suspended: ${e}`));
      if (env.FIX_SIM_QUEUE) {
        await env.FIX_SIM_QUEUE.send({ sim_id: sim.id, iccid }).catch(e =>
          console.error(`SIM ${iccid}: failed to enqueue fix-sim: ${e}`)
        );
      }
    }
    await restoreRotationStamp();
    throw new Error(`ATOMIC swapMSISDN failed: ${desc}`);
  }

  // Try to read new MSISDN from swap response; fall back to post-swap inquiry by SIM
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
    newMsisdn = inqR?.Result?.msisdn || inqR?.Result?.MSISDN || null;
  }

  if (!newMsisdn) throw new Error(`ATOMIC: no new MSISDN returned after swapMSISDN`);

  const e164 = normalizeUS(newMsisdn);
  const msisdnBare = String(newMsisdn).replace(/^\+?1?/, '');

  // 3) DB updates (same sequence as Helix rotation)
  // Offline for old MDN before closing it (only on rotation, not first activation).
  if (sim.msisdn && sim.msisdn !== msisdnBare) {
    try {
      await sendNumberOfflineWebhook(env, sim.id, normalizeUS(sim.msisdn), iccid, sim.msisdn, e164);
    } catch (offErr) {
      console.error(`[Rotator/ATOMIC] SIM ${sim.id}: number.offline failed: ${offErr}`);
    }
  }
  await closeCurrentNumber(env, sim.id);
  await insertNewNumber(env, sim.id, e164);
  await updateSimRotationTimestamp(env, sim.id);
  await sbPatch(env, `sims?id=eq.${encodeURIComponent(String(sim.id))}`, { msisdn: msisdnBare }, { logRows: true });

  // 4) Webhook (use MSISDN as the external identifier, same slot as mobility_subscription_id
  //    occupies for Helix SIMs — downstream reseller systems just need *an* ID)
  await sendNumberOnlineWebhook(env, sim.id, e164, iccid, msisdnBare);

  console.log(`SIM ${iccid}: ATOMIC rotated ${currentMsisdn} → ${msisdnBare} (${e164})`);
}

// ===========================
// Rotate one SIM from the batch or queue. Only ATOMIC rotates here; Teltik
// lines rotate in teltik-worker. claim_rotation_slot runs inside rotateAtomicSim.
// ===========================
async function rotateSingleSim(env, sim, opts = {}) {
  if (sim.vendor === 'atomic') {
    return await rotateAtomicSim(env, sim, { force: opts.force === true });
  }
  console.log(`SIM ${sim.iccid}: vendor ${sim.vendor} does not rotate in mdn-rotator — skipping`);
  return { skipped: true };
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
      // Non-critical: a failure (non-2xx or timeout) is logged and swallowed.
      await sbPatch(env, `sims?id=eq.${simId}`, { last_notified_at: new Date().toISOString() }, { prefer: 'return=minimal' });
    } catch (err) {
      console.error(`[Webhook] SIM ${simId}: last_notified_at PATCH failed (non-critical): ${err}`);
    }
  }
}

// ===========================
// Send number.offline webhook
// Fired before closeCurrentNumber when an MDN is being replaced. Resellers
// that route by phone-number (not sim_id) need the OLD number's offline event
// so they can deprovision the route before AT&T reassigns the MDN to another
// customer.
// ===========================
async function sendNumberOfflineWebhook(env, simId, oldNumber, iccid, oldMobilityId, newNumber) {
  const resellerId = await findResellerIdBySimId(env, simId);
  if (!resellerId) {
    console.log(`[Webhook] SIM ${simId}: no active reseller, skipping number.offline`);
    return;
  }
  const webhookUrl = await findWebhookUrlByResellerId(env, resellerId);
  if (!webhookUrl) {
    console.log(`[Webhook] SIM ${simId}: reseller ${resellerId} has no enabled webhook, skipping number.offline`);
    return;
  }

  const result = await sendWebhookWithDeduplication(env, webhookUrl, {
    event_type: 'number.offline',
    created_at: new Date().toISOString(),
    data: {
      sim_id: simId,
      number: oldNumber,
      online: false,
      iccid,
      mobilitySubscriptionId: oldMobilityId,
      replaced_by: newNumber,
      verified: true,
    },
  }, { idComponents: { simId, iccid, number: oldNumber }, resellerId });

  if (!result.ok) {
    console.error(`[Webhook] SIM ${simId}: number.offline FAILED after ${result.attempts} attempts (old=${oldNumber})`);
  }
  // Deliberately do NOT stamp last_notified_at — that's specifically the last
  // online notification timestamp.
}

// ===========================
// Fix SIM — ATOMIC only (Helix and Wing IoT are retired)
// ===========================
async function fixSim(env, simId) {
  const sims = await sbGet(
    env,
    `sims?select=id,iccid,vendor,gateway_host,msisdn,mobility_subscription_id,gateway_id,port,slot,current_imei_pool_id,status,imei,activated_at&id=eq.${encodeURIComponent(String(simId))}&limit=1`
  );
  if (!Array.isArray(sims) || sims.length === 0) {
    throw new Error(`SIM not found: ${simId}`);
  }
  const sim = sims[0];
  if (sim.vendor !== 'atomic') {
    throw new Error(`SIM ${sim.iccid}: fix is only supported for ATOMIC SIMs (vendor ${sim.vendor})`);
  }
  return await fixAtomicSim(env, sim);
}

// ===========================
// Fix a single ATOMIC SIM: new IMEI → inquiry → restore if suspended
// ===========================
async function fixAtomicSim(env, sim) {
  const iccid = sim.iccid;
  const simId = sim.id;
  const runId = `fixsim_atomic_${iccid}_${Date.now()}`;

  if (!env.ATOMIC_USERNAME || !env.ATOMIC_TOKEN || !env.ATOMIC_PIN) {
    throw new Error('ATOMIC credentials not configured on mdn-rotator worker');
  }

  const url = env.ATOMIC_API_URL || 'https://solutionsatt-atomic.telgoo5.com:22712';
  const session = {
    userName: env.ATOMIC_USERNAME,
    token: env.ATOMIC_TOKEN,
    pin: env.ATOMIC_PIN,
  };

  console.log(`[FixAtomicSim] Starting for SIM ${simId} (${iccid})`);

  // All live SIMs are Teltik-hosted: there is no gateway IMEI to write, so the
  // fix is the carrier-level inquiry + restore/reconnect below.
  const newImei = sim.imei || null;

  try {

    // Step 2: ATOMIC subscriber inquiry — get live status + MSISDN
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
      run_id: runId, step: 'subscriber_inquiry', iccid, imei: newImei, vendor: 'atomic',
      request_url: url, request_method: 'POST', request_body: inqBody,
      response_status: inqRes.status, response_ok: inqRes.ok,
      response_body_text: inqText, response_body_json: inqJson,
      error: (inqRes.ok && inqR?.statusCode === '00') ? null : `ATOMIC inquiry failed: ${inqR?.description || inqRes.status}`,
    });
    if (!inqRes.ok || inqR?.statusCode !== '00') {
      throw new Error(`ATOMIC inquiry failed: ${inqR?.description || inqRes.status}`);
    }

    const attStatus = inqR?.Result?.attStatus;
    const msisdnRaw = inqR?.Result?.msisdn || inqR?.Result?.MSISDN || sim.msisdn || null;
    console.log(`[FixAtomicSim] SIM ${iccid}: attStatus=${attStatus} msisdn=${msisdnRaw}`);

    // Sync MSISDN to DB if inquiry returned one
    if (msisdnRaw) {
      const msisdn10 = String(msisdnRaw).replace(/^\+?1?/, '').replace(/\D/g, '').slice(0, 10);
      if (msisdn10 !== sim.msisdn) {
        await sbPatch(env, `sims?id=eq.${encodeURIComponent(String(simId))}`, { msisdn: msisdn10 }, { logRows: true }).catch(() => {});
        console.log(`[FixAtomicSim] SIM ${iccid}: synced msisdn ${sim.msisdn} → ${msisdn10}`);
      }
    }

    // Step 3: Reactivate based on ATOMIC's current state.
    //   - Suspended → restoreSubscriber (reasonCode CR)
    //   - Cancelled / Deactivated → reconnectSubscriber (blank reasonCode)
    // restoreSubscriber rejects Cancelled SIMs, so branching on attStatus is required.
    // Fall back to DB msisdn if inquiry returned none (e.g., partially deactivated state).
    // If ATOMIC replies "subscriberNumber has changed to X", retry once with X.
    const needsReactivate = attStatus === 'Suspended' || attStatus === 'Cancelled' || attStatus === 'Deactivated';
    if (needsReactivate) {
      const mdnSource = msisdnRaw || sim.msisdn;
      const mdn10Initial = mdnSource ? String(mdnSource).replace(/^\+?1?/, '').replace(/\D/g, '').slice(0, 10) : '';
      if (!mdn10Initial) throw new Error(`SIM ${iccid}: no MSISDN available for reactivation (attStatus=${attStatus})`);

      const isCancelled = attStatus === 'Cancelled' || attStatus === 'Deactivated';
      const requestType = isCancelled ? 'reconnectSubscriber' : 'restoreSubscriber';
      const reasonCode = isCancelled ? '' : 'CR';
      const stepLabel = isCancelled ? 'reconnect_subscriber' : 'restore_subscriber';

      async function callReactivate(mdn10, retryLabel) {
        console.log(`[FixAtomicSim] SIM ${iccid}: calling ${requestType}${retryLabel || ''} (mdn=${mdn10})`);
        const reactivateBody = {
          wholeSaleApi: { session, wholeSaleRequest: { requestType, MSISDN: mdn10, reasonCode } },
        };
        const res = await relayFetch(env, url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(reactivateBody),
        });
        const text = await res.text();
        let json = {};
        try { json = JSON.parse(text); } catch {}
        const r = json?.wholeSaleApi?.wholeSaleResponse;
        await logCarrierApiCall(env, {
          run_id: runId, step: stepLabel + (retryLabel ? '_retry' : ''), iccid, imei: newImei, vendor: 'atomic',
          request_url: url, request_method: 'POST', request_body: reactivateBody,
          response_status: res.status, response_ok: res.ok,
          response_body_text: text, response_body_json: json,
          error: (res.ok && r?.statusCode === '00') ? null
            : `ATOMIC ${requestType} failed: ${r?.description || res.status}`,
        });
        return { ok: res.ok && r?.statusCode === '00', desc: r?.description || '', httpStatus: res.status };
      }

      let result = await callReactivate(mdn10Initial, '');

      // ATOMIC may reject with "subscriberNumber has changed to <NEW>" — parse and retry once.
      // The error text we've seen: "subscriberNumber has changed, ... The Subscriber has changed to 7043031130."
      if (!result.ok) {
        const match = result.desc.match(/(?:Subscriber has changed to|changed to)\s*\+?1?(\d{10})/i);
        if (match) {
          const newMdn = match[1];
          console.log(`[FixAtomicSim] SIM ${iccid}: ATOMIC reports current MSISDN=${newMdn} — syncing DB and retrying`);
          await sbPatch(env, `sims?id=eq.${encodeURIComponent(String(simId))}`, { msisdn: newMdn }, { logRows: true }).catch(() => {});
          result = await callReactivate(newMdn, ' (after-msisdn-sync)');
        }
      }

      if (!result.ok) {
        throw new Error(`ATOMIC ${requestType} failed: ${result.desc || result.httpStatus}`);
      }
      console.log(`[FixAtomicSim] SIM ${iccid}: subscriber ${requestType === 'reconnectSubscriber' ? 'reconnected' : 'restored'} successfully`);
      await sbPatch(env, `sims?id=eq.${encodeURIComponent(String(simId))}`, { status: 'active' }, { logRows: true }).catch(() => {});
    } else {
      console.log(`[FixAtomicSim] SIM ${iccid}: attStatus=${attStatus} — no reactivation needed`);
    }

  } catch (err) {
    console.error(`[FixAtomicSim] SIM ${iccid}: failed: ${err}`);
    throw err;
  }

  console.log(`[FixAtomicSim] SIM ${iccid}: fix complete (IMEI=${newImei})`);
  return { imei: newImei };
}

// ===========================
// Change IMEI for a Teltik-hosted SIM: no Skyline gateway/port exists to write
// the modem IMEI to, so this skips that step entirely and performs the
// carrier-side IMEI update instead. Only ATOMIC (AT&T) exposes a carrier-side
// IMEI update (swapImei); other vendors are not yet wired up here.
// ===========================
async function changeImeiTeltikHosted(env, sim, sim_id, iccid, autoImei, newImeiRaw) {
  const fail = (error, status) => new Response(JSON.stringify({
    ok: false, error, gateway_host: 'teltik', gateway_skipped: true,
  }), { status, headers: { "Content-Type": "application/json" } });

  if (autoImei) {
    return fail(`SIM ${iccid} is Teltik-hosted: auto IMEI allocation draws from the Skyline pool, which does not apply here. Provide new_imei explicitly.`, 400);
  }
  if (sim.vendor !== 'atomic') {
    return fail(`SIM ${iccid} is Teltik-hosted and vendor '${sim.vendor}' has no carrier-side IMEI update wired up; only ATOMIC (AT&T) swapImei is supported.`, 400);
  }
  if (!env.ATOMIC_USERNAME || !env.ATOMIC_TOKEN || !env.ATOMIC_PIN) {
    return fail("ATOMIC credentials not configured", 500);
  }

  const msisdn = resolveMsisdn(sim);
  if (!msisdn) return fail(`No MSISDN on file for SIM ${iccid}`, 400);
  const zipCode = resolveZip(null, sim);
  if (!zipCode) return fail(`No PPU zip on file for SIM ${iccid}; required for ATOMIC swapImei`, 400);

  const runId = `change_imei_teltik_${iccid}_${Date.now()}`;
  const atomicUrl = env.ATOMIC_API_URL || 'https://solutionsatt-atomic.telgoo5.com:22712';
  const requestBody = buildSwapImeiRequest({
    session: { userName: env.ATOMIC_USERNAME, token: env.ATOMIC_TOKEN, pin: env.ATOMIC_PIN },
    msisdn, zipCode, imei: newImeiRaw,
  });

  const res = await relayFetch(env, atomicUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  const success = res.ok && isSwapSuccess(data);
  const errMsg = success ? null : swapErrorMessage(data, res.status);

  await logCarrierApiCall(env, {
    run_id: runId, step: 'change_imei_teltik_hosted', iccid, imei: newImeiRaw, vendor: 'atomic',
    request_url: atomicUrl, request_method: 'POST', request_body: requestBody,
    response_status: res.status, response_ok: res.ok,
    response_body_text: text, response_body_json: data, error: errMsg,
  });

  if (!success) {
    return fail(`Skyline hardware update skipped (SIM ${iccid} is Teltik-hosted). ATOMIC carrier-side IMEI update failed: ${errMsg}`, res.status >= 400 ? res.status : 502);
  }

  await sbPatch(env, `sims?id=eq.${encodeURIComponent(String(sim_id))}`, { imei: newImeiRaw }, { logRows: true });

  return new Response(JSON.stringify({
    ok: true, action: 'change_imei', sim_id, iccid, imei: newImeiRaw,
    gateway_host: 'teltik', gateway_skipped: true,
    message: `Skyline hardware update skipped (SIM ${iccid} is Teltik-hosted). ATOMIC carrier-side IMEI update to ${newImeiRaw} succeeded.`,
    detail: data,
  }, null, 2), { status: 200, headers: { "Content-Type": "application/json" } });
}

// ===========================
// Retry Activation for error-status SIMs
// ===========================

function relayFetch(env, url, init, send = carrierFetch) {
  if (env.RELAY_URL && env.RELAY_KEY) {
    return send(env, `${env.RELAY_URL}/${url}`, {
      ...init,
      headers: {
        ...(init?.headers || {}),
        'x-relay-key': env.RELAY_KEY,
      },
    });
  }
  return send(env, url, init);
}

// Read-only ATOMIC portinStatus lookup — shared by the /atomic-portin-status
// route (called by details-finalizer's poll and the dashboard's manual
// action) and by /sim-action's "portin_status" branch, so both entry points
// log to carrier_api_logs and redact the session the same way. Per the
// atomic-wholesale-api skill, MSISDN is the only field this requestType
// accepts; never sends port account/PIN or subscriber data, and never
// submits/cancels/updates a port. Does not interpret the carrier's
// statusCode/description — callers record it as-is.
async function lookupAtomicPortinStatus(env, { msisdn, iccid }) {
  try {
    const atomicUrl = env.ATOMIC_API_URL || 'https://solutionsatt-atomic.telgoo5.com:22712';
    const requestBody = buildAtomicPortInStatusRequest({
      session: {
        userName: env.ATOMIC_USERNAME,
        token: env.ATOMIC_TOKEN,
        pin: env.ATOMIC_PIN,
      },
      msisdn,
    });
    const runId = `portin_status_${iccid || msisdn}_${Date.now()}`;
    const res = await relayFetch(env, atomicUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch {}
    const wr = data?.wholeSaleApi?.wholeSaleResponse;
    await logCarrierApiCall(env, {
      run_id: runId, step: 'portin_status', iccid: iccid || null, imei: null, vendor: 'atomic',
      request_url: atomicUrl, request_method: 'POST', request_body: redactAtomicSession(requestBody),
      response_status: res.status, response_ok: res.ok,
      response_body_text: text, response_body_json: data,
      error: (res.ok && wr?.statusCode === '00') ? null :
        `ATOMIC portinStatus failed: ${wr?.description || res.status}`,
    });
    return {
      ok: res.ok,
      http_status: res.status,
      statusCode: wr?.statusCode ?? null,
      description: wr?.description ?? null,
      result: wr?.Result ?? null,
    };
  } catch (err) {
    return { ok: false, http_status: 0, statusCode: null, description: null, result: null, error: String(err) };
  }
}

// Blanks the ATOMIC session credentials (userName/token/pin) before a request
// body is written to carrier_api_logs. Same field set as the dashboard API
// Tester's REDACTED_BODY_FIELDS allow-list.
function redactAtomicSession(body) {
  try {
    const clone = JSON.parse(JSON.stringify(body));
    const session = clone?.wholeSaleApi?.session;
    if (session) {
      if ('userName' in session) session.userName = '[REDACTED]';
      if ('token' in session) session.token = '[REDACTED]';
      if ('pin' in session) session.pin = '[REDACTED]';
    }
    return clone;
  } catch {
    return body;
  }
}

function normalizeUS(phone) {
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return phone;
}

async function logCarrierApiCall(env, logData) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return;
  const vendor = logData.vendor || 'atomic';
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
  // raw: a non-2xx is logged and ignored; a timeout still throws.
  const res = await sbPost(env, 'carrier_api_logs', payload, { prefer: 'return=minimal', raw: true });
  if (!res.ok) console.error('[Carrier Log] Supabase failed: ' + res.status);
}

// ===========================
// Supabase helpers
// ===========================
// Atomic check-and-stamp for a rotation slot. Returns true iff this caller
// should proceed with the external rotation. p_force=true bypasses the
// per-vendor interval guard AND the activation-day skip — reserved for manual.
async function claimRotationSlot(env, simId, force) {
  // A non-2xx throws (SupabaseError), as before.
  return (await sbRpc(env, 'claim_rotation_slot', { p_sim_id: simId, p_force: !!force })) === true;
}

// Returns the current hour (0-23) in America/New_York, DST-aware.
// Intl midnight sometimes renders as "24" in en-US with hour12:false; % 24 normalises.
function getNYHour() {
  const raw = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', hour12: false,
  }).format(new Date()));
  return ((raw % 24) + 24) % 24;
}

// Scheduled rotations only run between 12:00 AM and 9:00 AM NY (hours 0-8).
// Manual HTTP paths bypass this — they never pass through scheduled().
function isInsideRotationWindowNY() {
  const h = getNYHour();
  return h >= 0 && h <= 8;
}

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

async function closeCurrentNumber(env, simId) {
  console.log(`[DB] Closing current number for sim_id=${simId}`);
  await sbPatch(
    env,
    `sim_numbers?sim_id=eq.${encodeURIComponent(String(simId))}&valid_to=is.null`,
    { valid_to: new Date().toISOString() }, { logRows: true }
  );
  console.log(`[DB] Closed current number for sim_id=${simId}`);
}

async function insertNewNumber(env, simId, e164) {
  console.log(`[DB] Inserting new number ${e164} for sim_id=${simId}`);
  await sbPost(env, "sim_numbers", [
    {
      sim_id: simId,
      e164,
      valid_from: new Date().toISOString(),
      verification_status: 'verified',
    },
  ], { logRows: true });
  console.log(`[DB] Inserted new number ${e164} for sim_id=${simId}`);
}

async function updateSimRotationTimestamp(env, simId) {
  const now = new Date().toISOString();
  console.log(`[DB] Updating rotation timestamp for sim_id=${simId}`);
  await sbPatch(
    env,
    `sims?id=eq.${encodeURIComponent(String(simId))}`,
    {
      last_mdn_rotated_at: now,
      last_rotation_at: now,
      rotation_status: 'success',
      last_rotation_error: null,
      rotation_fail_count: 0,
      status: 'active',
    }, { logRows: true }
  );
  console.log(`[DB] Updated rotation timestamp for sim_id=${simId}`);
}

async function updateSimRotationError(env, simId, errorMessage) {
  console.log(`[DB] Recording rotation error for sim_id=${simId}`);
  const todayNY = getNYMidnightISO();
  // raw: a non-2xx only shows up as an odd count in the log below (as before).
  const res = await sbRpc(env, 'increment_rotation_fail', { p_sim_id: simId, p_error: errorMessage, p_today_start: todayNY }, { raw: true });
  const newCount = await res.json().catch(() => null);
  if (newCount >= 5) {
    console.log(`[DB] SIM ${simId}: rotation_fail_count=${newCount} → status=rotation_failed (cap reached, no further auto attempts)`);
  } else {
    console.log(`[DB] SIM ${simId}: rotation_fail_count=${newCount} (attempt ${newCount}/5 — will retry next cron)`);
  }
}

async function findResellerIdBySimId(env, simId) {
  if (!simId) return null;
  const q = `reseller_sims?select=reseller_id&sim_id=eq.${encodeURIComponent(String(simId))}&active=eq.true&limit=1`;
  // raw: a non-2xx means "not found" (null) below; a timeout still throws.
  const res = await sbGet(env, q, { raw: true });
  if (!res.ok) return null;
  const data = await res.json();
  return Array.isArray(data) && data[0]?.reseller_id ? data[0].reseller_id : null;
}

async function findWebhookUrlByResellerId(env, resellerId) {
  if (!resellerId) return null;
  const q = `reseller_webhooks?select=url&reseller_id=eq.${encodeURIComponent(String(resellerId))}&enabled=eq.true&limit=1`;
  // raw: a non-2xx means "not found" (null) below; a timeout still throws.
  const res = await sbGet(env, q, { raw: true });
  if (!res.ok) return null;
  const data = await res.json();
  return Array.isArray(data) && data[0]?.url ? data[0].url : null;
}

// ===========================
// WEBHOOK UTILITIES (with deduplication and retry)
// ===========================

async function generateMessageIdAsync(components) {
  const { eventType, simId, iccid, number, from, body, timestamp } = components;

  // number.online / number.offline: deduplicate per day (one send per SIM per
  // number per UTC day). Other events: deduplicate per minute (prevents
  // double-send on retry within the same minute).
  let dedupeTs;
  if (eventType === 'number.online' || eventType === 'number.offline') {
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
  // raw: a non-2xx counts as "not delivered" below; a timeout still throws.
  const res = await sbGet(env, `webhook_deliveries?message_id=eq.${encodeURIComponent(messageId)}&status=eq.delivered&limit=1`, { raw: true });

  if (!res.ok) return false;
  const data = await res.json();
  return Array.isArray(data) && data.length > 0;
}

async function recordWebhookDelivery(env, delivery) {
  const { messageId, eventType, resellerId, webhookUrl, payload, status, attempts, responseBody } = delivery;

  // raw: a non-2xx is deliberately ignored (as before); a timeout still throws.
  await sbPost(env, 'webhook_deliveries', {
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
  }, { prefer: 'resolution=merge-duplicates', raw: true });
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
      }, webhookFetch);

      lastStatus = res.status;

      const responseBody = await res.text().catch(() => '');

      if (res.ok) {
        // number.online: 2xx is only a true success if the reseller echoes a rentalId.
        // Incident 2026-05-11 16:59:57Z: TrustOTP returned 200 with empty body for a
        // ~53s batch; we marked 168 SIMs delivered, no rentals were created on their
        // side, and the next-day per-day dedup hid the gap. Retry on empty body; if
        // retries fail, status='failed' is written and the daily backstop picks it up.
        if (payload?.event_type === 'number.online' && parseRentalIdFromResponse(responseBody) == null) {
          lastError = `2xx with no rentalId (status ${res.status}, body ${responseBody.slice(0, 200) || '<empty>'})`;
          console.log(`[Webhook] ${lastError} for ${messageId} — retrying`);
        } else {
          console.log(`[Webhook] Success ${res.status} for ${messageId} after ${attempt} attempt(s)`);
          return { ok: true, status: res.status, attempts: attempt, responseBody };
        }
      } else if (res.status >= 400 && res.status < 500) {
        console.log(`[Webhook] Client error ${res.status} for ${messageId}: ${responseBody.slice(0, 200)}`);
        return { ok: false, status: res.status, attempts: attempt, error: `Client error: ${res.status}`, responseBody };
      } else {
        lastError = `Server error ${res.status}: ${responseBody.slice(0, 200)}`;
        console.log(`[Webhook] ${lastError} for ${messageId}`);
      }

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

// Loose rentalId extractor; matches TrustOTP's {"rentalId":N} and any reseller that
// returns rental_id / id. Used by postWebhookWithRetry to validate number.online 2xx.
function parseRentalIdFromResponse(body) {
  if (!body) return null;
  const s = String(body);
  try {
    const obj = JSON.parse(s);
    const v = obj && (obj.rentalId ?? obj.rental_id ?? obj.id);
    if (v != null) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch {}
  const m = s.match(/"rental[_]?[Ii]d"\s*:\s*([0-9]+)/);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
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

  if (result.ok && !result.skipped) {
    try {
      const persisted = await persistRentalFromWebhookResponse({
        env,
        payload,
        responseBody: result.responseBody,
        resellerId: options.resellerId,
        deliveredAt: new Date().toISOString(),
      });
      if (persisted.upserted) {
        console.log(`[Webhook] rentals upsert ok for ${messageId} → reseller_rental_id=${persisted.rentalContext?.reseller_rental_id}`);
      } else if (persisted.reason && persisted.reason !== 'not_number_online' && persisted.reason !== 'no_rental_id_in_response') {
        console.log(`[Webhook] rentals upsert skipped for ${messageId}: ${persisted.reason}`);
      }
    } catch (err) {
      console.log(`[Webhook] rentals upsert threw for ${messageId}: ${err}`);
    }
  }

  return result;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
    errors = await sbGet(env, query);
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
    }, webhookFetch);

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
