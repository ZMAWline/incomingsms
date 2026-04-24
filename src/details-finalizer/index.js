// =========================================================
// DETAILS FINALIZER WORKER
// Cron: every 5 minutes.
// Runs four finalizers per tick:
//   1) Helix finalizer — for provisioning Helix SIMs (gated on HELIX_ENABLED)
//   2) Wing IoT finalizer — for provisioning Wing IoT SIMs (activation + post-rotation)
//   3) Teltik finalizer — for provisioning Teltik SIMs (post-rotation MDN sync)
//   4) ATOMIC finalizer — for ATOMIC SIMs stuck after 5xx/network error during swapMSISDN
//      (calls mdn-rotator's /atomic-inquiry via service binding since it holds ATOMIC creds)
// =========================================================

import { syncSimFromHelixDetails } from '../shared/subscriber-sync.js';

const TELTIK_BASE = 'https://api.smsgateway.xyz';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname !== '/run') {
      return new Response('details-finalizer ok. Use /run?secret=...', { status: 200 });
    }
    const secret = url.searchParams.get('secret') || '';
    if (!env.FINALIZER_RUN_SECRET || secret !== env.FINALIZER_RUN_SECRET) {
      return new Response('Unauthorized', { status: 401 });
    }
    const limitParam = url.searchParams.get('limit');
    const limit = limitParam ? Math.max(parseInt(limitParam, 10) || 1, 1) : 1000;
    const helix = await runHelixFinalizer(env, limit);
    const wing = await runWingIotFinalizer(env, limit);
    const teltik = await runTeltikFinalizer(env, limit);
    const atomic = await runAtomicFinalizer(env, limit);
    return json({ ok: true, helix, wing, teltik, atomic });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runHelixFinalizer(env, 25));
    ctx.waitUntil(runWingIotFinalizer(env, 50));
    ctx.waitUntil(runTeltikFinalizer(env, 50));
    ctx.waitUntil(runAtomicFinalizer(env, 50));
  },
};

/* ── Helix finalizer ──────────────────────────────────────────────────────── */

async function runHelixFinalizer(env, limit) {
  if (env.HELIX_ENABLED !== 'true') {
    return { processed: 0, activated: 0, message: 'helix_disabled' };
  }
  const token = await hxGetBearerToken(env);

  const sims = await supabaseSelect(
    env,
    `sims?select=id,iccid,mobility_subscription_id,status,imei,activated_at,vendor&status=eq.provisioning&vendor=eq.helix&limit=${limit}`
  );

  let processed = 0;
  let activated = 0;
  let errors = 0;

  for (const sim of sims) {
    processed++;
    const subId = sim.mobility_subscription_id;
    if (!subId) continue;

    let d;
    try {
      const details = await hxSubscriberDetails(env, token, subId);
      d = Array.isArray(details) ? details[0] : details;
    } catch (e) {
      console.error(`[Finalizer/Helix] subId=${subId} iccid=${sim.iccid}: subscriber_details failed: ${e}`);
      errors++;
      continue;
    }

    let synced;
    try {
      synced = await syncSimFromHelixDetails(env, sim, d, { isFinalization: true });
    } catch (e) {
      console.error(`[Finalizer/Helix] sim_id=${sim.id}: sync failed: ${e}`);
      errors++;
      continue;
    }

    if (synced.iccidMismatch) {
      errors++;
      continue;
    }

    if (synced.statusUpdated) {
      console.log(`[Finalizer/Helix] sim_id=${sim.id}: Helix status → ${synced.statusUpdated}, skipping activation`);
      continue;
    }

    if (!synced.phoneNumber) {
      console.log(`[Finalizer/Helix] sim_id=${sim.id} iccid=${sim.iccid}: no MDN yet, will retry`);
      continue;
    }

    const activatedAt = synced.activatedAt || sim.activated_at || new Date().toISOString();
    await supabasePatch(
      env,
      `sims?id=eq.${encodeURIComponent(String(sim.id))}`,
      { status: 'active', status_reason: null, activated_at: activatedAt }
    );
    activated++;
    console.log(`[Finalizer/Helix] SIM ${sim.iccid} (id=${sim.id}): activated with MDN ${synced.phoneNumber}`);
  }

  return { ok: true, processed, activated, errors };
}

/* ── Wing IoT finalizer ───────────────────────────────────────────────────── */

async function runWingIotFinalizer(env, limit) {
  if (!env.WING_IOT_USERNAME || !env.WING_IOT_API_KEY) {
    return { processed: 0, synced: 0, message: 'wing_iot_credentials_missing' };
  }

  // Catches both post-activation (msisdn IS NULL) and post-rotation (rotation_status='mdn_pending').
  // Both states use status='provisioning' — the unified signal that details-finalizer owns MDN sync.
  const sims = await supabaseSelect(
    env,
    `sims?select=id,iccid,msisdn,rotation_status,status,activated_at&vendor=eq.wing_iot&status=eq.provisioning&limit=${limit}`
  );
  if (!sims || sims.length === 0) return { ok: true, processed: 0, synced: 0 };

  const baseUrl = env.WING_IOT_BASE_URL || 'https://restapi19.att.com/rws/api';
  const auth = 'Basic ' + btoa(env.WING_IOT_USERNAME + ':' + env.WING_IOT_API_KEY);
  const headers = { Authorization: auth, Accept: 'application/json' };

  let processed = 0;
  let synced = 0;
  let errors = 0;
  const results = [];

  for (const sim of sims) {
    processed++;
    const isPostRotation = sim.rotation_status === 'mdn_pending';
    const url = baseUrl + '/v1/devices/' + encodeURIComponent(sim.iccid);

    try {
      const res = await relayFetch(env, url, { method: 'GET', headers });
      if (!res.ok) {
        errors++;
        results.push({ iccid: sim.iccid, ok: false, error: `GET ${res.status}` });
        continue;
      }
      const data = await res.json().catch(() => ({}));
      const mdnRaw = data.msisdn || data.mdn || null;
      if (!mdnRaw) {
        results.push({ iccid: sim.iccid, ok: true, pending: true });
        continue;
      }

      const msisdnBare = String(mdnRaw).replace(/^\+?1?/, '');

      // Post-rotation: AT&T may still return the old MDN during the ~1 min propagation window.
      // Skip until it changes — the next cron tick in 5 min will try again.
      if (isPostRotation && sim.msisdn && msisdnBare === sim.msisdn) {
        results.push({ iccid: sim.iccid, ok: true, pending: true, note: 'old MDN not yet replaced' });
        continue;
      }

      // Guardrail: refuse to mark success while AT&T still has the SIM on the non-dialable (ABIR)
      // plan. Happens when rotation's second PUT returned 200 but AT&T didn't actually switch back.
      // Skip; mdn-rotator's verify_dialable poll should have thrown, but keep this as defense-in-depth.
      const plan = data.communicationPlan || null;
      if (isPostRotation && plan && plan !== 'Wing Tel Inc - NON ABIR SMS MO/MT US') {
        results.push({ iccid: sim.iccid, ok: true, pending: true, note: `plan=${plan} (not dialable yet)` });
        continue;
      }

      const e164 = normalizeUS(mdnRaw);

      await closeCurrentNumber(env, sim.id);
      await insertNewNumber(env, sim.id, e164);

      const patch = {
        msisdn: msisdnBare,
        status: 'active',
      };
      if (isPostRotation) patch.rotation_status = 'success';
      // Backfill activated_at when it's null (first time the SIM becomes usable).
      // Never override an existing date — that's the real activation timestamp.
      if (!sim.activated_at) patch.activated_at = new Date().toISOString();
      await supabasePatch(env, `sims?id=eq.${encodeURIComponent(String(sim.id))}`, patch);

      await sendNumberOnlineWebhook(env, sim.id, e164, sim.iccid, msisdnBare);

      synced++;
      results.push({ iccid: sim.iccid, ok: true, mdn: e164, kind: isPostRotation ? 'post-rotation' : 'activation' });
      console.log(`[Finalizer/WingIoT] SIM ${sim.iccid}: wrote ${e164} (${isPostRotation ? 'post-rotation' : 'activation'})`);
    } catch (e) {
      errors++;
      results.push({ iccid: sim.iccid, ok: false, error: String(e) });
      console.error(`[Finalizer/WingIoT] SIM ${sim.iccid}: ${e}`);
    }
  }

  return { ok: true, processed, synced, errors, results };
}

/* ── Teltik finalizer ─────────────────────────────────────────────────────── */

async function runTeltikFinalizer(env, limit) {
  if (!env.TELTIK_API_KEY) {
    return { processed: 0, synced: 0, message: 'teltik_api_key_missing' };
  }

  // Post-rotation: rotateOneTeltikSim flipped status=provisioning + rotation_status=mdn_pending.
  // sim.msisdn still holds the OLD MDN — we call get-phone-number; when the returned MDN
  // differs, the change-number actually took effect and we finalize.
  const sims = await supabaseSelect(
    env,
    `sims?select=id,iccid,msisdn,rotation_status,status,last_mdn_rotated_at,rotation_interval_hours&vendor=eq.teltik&status=eq.provisioning&rotation_status=eq.mdn_pending&limit=${limit}`
  );
  if (!sims || sims.length === 0) return { ok: true, processed: 0, synced: 0 };

  const apiKey = env.TELTIK_API_KEY;
  const STUCK_MINUTES = 30;

  let processed = 0;
  let synced = 0;
  let errors = 0;
  let failed = 0;
  const results = [];

  for (const sim of sims) {
    processed++;
    const url = `${TELTIK_BASE}/v1/get-phone-number/?apikey=${apiKey}&iccid=${encodeURIComponent(sim.iccid)}`;
    const runId = `finalize_${sim.iccid}_${Date.now()}`;

    try {
      const res = await relayFetch(env, url, { method: 'GET' });
      const bodyText = await res.text();
      let data = {};
      try { data = JSON.parse(bodyText); } catch {}
      await logTeltikApiCall(env, {
        run_id: runId, step: 'post_rotate_get', iccid: sim.iccid,
        request_url: url.replace(/apikey=[^&]+/, 'apikey=***'),
        request_method: 'GET', request_body: null,
        response_status: res.status, response_ok: res.ok,
        response_body_text: bodyText, response_body_json: data,
        error: res.ok ? null : `GET ${res.status}`,
      });
      if (!res.ok) {
        errors++;
        results.push({ iccid: sim.iccid, ok: false, error: `GET ${res.status}` });
        continue;
      }
      const raw = data.msisdn || data.mdn || data.phone_number || data.number || null;
      const msisdnBare = raw ? String(raw).replace(/\D/g, '').replace(/^1(\d{10})$/, '$1') : null;

      // Timeout guard: if Teltik hasn't changed the MDN in STUCK_MINUTES, mark failed so
      // dashboard/ops can see it. last_mdn_rotated_at was stamped by claim_rotation_slot.
      const startedAt = sim.last_mdn_rotated_at ? new Date(sim.last_mdn_rotated_at).getTime() : 0;
      const ageMin = startedAt ? (Date.now() - startedAt) / 60000 : 0;

      if (!msisdnBare || msisdnBare === sim.msisdn) {
        if (ageMin >= STUCK_MINUTES) {
          failed++;
          await supabasePatch(env, `sims?id=eq.${encodeURIComponent(String(sim.id))}`, {
            rotation_status: 'failed',
            status: 'active',
            last_rotation_error: `MDN did not change within ${STUCK_MINUTES}m (Teltik returned ${msisdnBare || 'null'})`,
          });
          results.push({ iccid: sim.iccid, ok: false, note: 'timeout' });
        } else {
          results.push({ iccid: sim.iccid, ok: true, pending: true, note: 'MDN unchanged — still pending' });
        }
        continue;
      }

      // Finalize
      const e164 = `+1${msisdnBare}`;
      await closeCurrentNumber(env, sim.id);
      await insertNewNumber(env, sim.id, e164);
      await supabasePatch(env, `sims?id=eq.${encodeURIComponent(String(sim.id))}`, {
        msisdn: msisdnBare,
        status: 'active',
        rotation_status: 'success',
        last_rotation_error: null,
      });

      await sendTeltikNumberOnlineWebhook(env, sim, e164, msisdnBare);

      synced++;
      results.push({ iccid: sim.iccid, ok: true, mdn: e164, kind: 'post-rotation' });
      console.log(`[Finalizer/Teltik] SIM ${sim.iccid}: wrote ${e164} (post-rotation)`);
    } catch (e) {
      errors++;
      results.push({ iccid: sim.iccid, ok: false, error: String(e) });
      console.error(`[Finalizer/Teltik] SIM ${sim.iccid}: ${e}`);
    }
  }

  return { ok: true, processed, synced, errors, failed, results };
}

async function sendTeltikNumberOnlineWebhook(env, sim, e164, msisdnBare) {
  const resellerId = await findResellerIdBySimId(env, sim.id);
  if (!resellerId) return;
  const webhookUrl = await findWebhookUrlByResellerId(env, resellerId);
  if (!webhookUrl) return;

  const intervalHours = sim.rotation_interval_hours || 48;
  const onlineUntil = midnightNYAfterInterval(sim.last_mdn_rotated_at, intervalHours);

  const result = await sendWebhookWithDeduplication(env, webhookUrl, {
    event_type: 'number.online',
    created_at: new Date().toISOString(),
    data: {
      sim_id: sim.id,
      number: e164,
      online: true,
      online_until: onlineUntil,
      carrier: 'T-Mobile',
      iccid: sim.iccid,
      mobilitySubscriptionId: null,
      verified: true,
    },
  }, { idComponents: { simId: sim.id, iccid: sim.iccid, number: e164 }, resellerId });

  if (result.ok) {
    await supabasePatch(env, `sims?id=eq.${encodeURIComponent(String(sim.id))}`, {
      last_notified_at: new Date().toISOString(),
    }).catch(() => {});
  }
}

async function logTeltikApiCall(env, logData) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return;
  const payload = {
    run_id: logData.run_id,
    step: logData.step,
    iccid: logData.iccid || null,
    imei: null,
    vendor: 'teltik',
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
  try {
    await fetch(`${env.SUPABASE_URL}/rest/v1/carrier_api_logs`, {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.warn(`[Teltik API log] insert failed: ${e}`);
  }
}

function midnightNYAfterInterval(lastRotatedAt, intervalHours) {
  const baseDt = new Date(lastRotatedAt || Date.now());
  const nyDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(baseDt);
  const [y, m, d] = nyDate.split('-').map(Number);
  const intervalDays = Math.ceil((intervalHours || 48) / 24);
  const probe = new Date(Date.UTC(y, m - 1, d + intervalDays, 5, 0, 0));
  const probeNyDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(probe);
  const tzPart = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', timeZoneName: 'shortOffset'
  }).formatToParts(probe).find(p => p.type === 'timeZoneName')?.value ?? 'GMT-4';
  const offsetHours = -parseInt(tzPart.replace('GMT', '') || '-4');
  return new Date(`${probeNyDate}T${String(offsetHours).padStart(2, '0')}:00:00.000Z`).toISOString();
}

/* ── ATOMIC finalizer ─────────────────────────────────────────────────────── */

async function runAtomicFinalizer(env, limit) {
  if (!env.MDN_ROTATOR) {
    return { processed: 0, synced: 0, message: 'mdn_rotator_binding_missing' };
  }
  if (!env.ADMIN_RUN_SECRET) {
    return { processed: 0, synced: 0, message: 'admin_run_secret_missing' };
  }

  // Only reconcile post-rotation stuck ATOMIC SIMs; normal activation flow doesn't use
  // provisioning for ATOMIC. mdn_pending is the signal that swapMSISDN returned 5xx or
  // threw a network error and we don't know the final state.
  const sims = await supabaseSelect(
    env,
    `sims?select=id,iccid,msisdn,rotation_status,status,last_mdn_rotated_at&vendor=eq.atomic&status=eq.provisioning&rotation_status=eq.mdn_pending&limit=${limit}`
  );
  if (!sims || sims.length === 0) return { ok: true, processed: 0, synced: 0 };

  const STUCK_MINUTES = 30;

  let processed = 0;
  let synced = 0;
  let errors = 0;
  let failed = 0;
  const results = [];

  for (const sim of sims) {
    processed++;
    try {
      const inqUrl = `https://mdn-rotator/atomic-inquiry?secret=${encodeURIComponent(env.ADMIN_RUN_SECRET)}&iccid=${encodeURIComponent(sim.iccid)}`;
      const res = await env.MDN_ROTATOR.fetch(inqUrl, { method: 'GET' });
      if (!res.ok) {
        errors++;
        results.push({ iccid: sim.iccid, ok: false, error: `inquiry ${res.status}` });
        continue;
      }
      const data = await res.json().catch(() => ({}));
      const newMsisdn = data.msisdn ? String(data.msisdn).replace(/^\+?1?/, '') : null;

      const startedAt = sim.last_mdn_rotated_at ? new Date(sim.last_mdn_rotated_at).getTime() : 0;
      const ageMin = startedAt ? (Date.now() - startedAt) / 60000 : 0;

      if (!data.ok || !newMsisdn || newMsisdn === sim.msisdn) {
        if (ageMin >= STUCK_MINUTES) {
          failed++;
          await supabasePatch(env, `sims?id=eq.${encodeURIComponent(String(sim.id))}`, {
            rotation_status: 'failed',
            status: 'active',
            last_rotation_error: `ATOMIC inquiry: MDN unchanged within ${STUCK_MINUTES}m (got ${newMsisdn || 'null'})`,
          });
          results.push({ iccid: sim.iccid, ok: false, note: 'timeout' });
        } else {
          results.push({ iccid: sim.iccid, ok: true, pending: true, note: 'MDN unchanged — still pending' });
        }
        continue;
      }

      const e164 = `+1${newMsisdn}`;
      await closeCurrentNumber(env, sim.id);
      await insertNewNumber(env, sim.id, e164);
      await supabasePatch(env, `sims?id=eq.${encodeURIComponent(String(sim.id))}`, {
        msisdn: newMsisdn,
        status: 'active',
        rotation_status: 'success',
        last_rotation_error: null,
      });

      await sendNumberOnlineWebhook(env, sim.id, e164, sim.iccid, newMsisdn);

      synced++;
      results.push({ iccid: sim.iccid, ok: true, mdn: e164, kind: 'post-rotation-recovery' });
      console.log(`[Finalizer/ATOMIC] SIM ${sim.iccid}: reconciled ${sim.msisdn} → ${newMsisdn}`);
    } catch (e) {
      errors++;
      results.push({ iccid: sim.iccid, ok: false, error: String(e) });
      console.error(`[Finalizer/ATOMIC] SIM ${sim.iccid}: ${e}`);
    }
  }

  return { ok: true, processed, synced, errors, failed, results };
}

/* ── Relay ────────────────────────────────────────────────────────────────── */

function relayFetch(env, url, init) {
  if (env.RELAY_URL && env.RELAY_KEY) {
    return fetch(`${env.RELAY_URL}/${url}`, {
      ...init,
      headers: { ...(init?.headers || {}), 'x-relay-key': env.RELAY_KEY },
    });
  }
  return fetch(url, init);
}

/* ── Helix ────────────────────────────────────────────────────────────────── */

async function hxGetBearerToken(env) {
  const res = await relayFetch(env, env.HX_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'password',
      client_id: env.HX_CLIENT_ID,
      audience: env.HX_AUDIENCE,
      username: env.HX_GRANT_USERNAME,
      password: env.HX_GRANT_PASSWORD,
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error('Failed to get Helix token');
  return data.access_token;
}

async function hxSubscriberDetails(env, token, mobilitySubscriptionId) {
  const res = await relayFetch(env, `${env.HX_API_BASE}/api/mobility-subscriber/details`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ mobilitySubscriptionId }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`subscriber_details failed ${res.status}`);
  return data;
}

/* ── Supabase ─────────────────────────────────────────────────────────────── */

async function supabaseSelect(env, path) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`Supabase SELECT ${res.status}: ${await res.text().catch(() => '')}`);
  return res.json();
}

async function supabasePatch(env, path, body) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase PATCH ${res.status}: ${await res.text().catch(() => '')}`);
}

async function supabaseInsert(env, table, rows) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`Supabase INSERT ${res.status}: ${await res.text().catch(() => '')}`);
}

/* ── sim_numbers helpers ──────────────────────────────────────────────────── */

async function closeCurrentNumber(env, simId) {
  await supabasePatch(
    env,
    `sim_numbers?sim_id=eq.${encodeURIComponent(String(simId))}&valid_to=is.null`,
    { valid_to: new Date().toISOString() }
  );
}

async function insertNewNumber(env, simId, e164) {
  await supabaseInsert(env, 'sim_numbers', [
    {
      sim_id: simId,
      e164,
      valid_from: new Date().toISOString(),
      verification_status: 'verified',
    },
  ]);
}

function normalizeUS(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}

/* ── Webhook (number.online) ──────────────────────────────────────────────── */

async function sendNumberOnlineWebhook(env, simId, number, iccid, mobilitySubscriptionId) {
  const resellerId = await findResellerIdBySimId(env, simId);
  if (!resellerId) {
    console.log(`[Webhook] SIM ${simId}: no active reseller, skipping number.online`);
    return;
  }
  const webhookUrl = await findWebhookUrlByResellerId(env, resellerId);
  if (!webhookUrl) {
    console.log(`[Webhook] SIM ${simId}: reseller ${resellerId} has no enabled webhook`);
    return;
  }

  const result = await sendWebhookWithDeduplication(env, webhookUrl, {
    event_type: 'number.online',
    created_at: new Date().toISOString(),
    data: {
      sim_id: simId,
      number,
      online: true,
      online_until: nextRotationUtcISO(),
      iccid,
      mobilitySubscriptionId,
      verified: true,
    },
  }, { idComponents: { simId, iccid, number }, resellerId });

  if (!result.ok) {
    console.error(`[Webhook] SIM ${simId}: number.online FAILED after ${result.attempts} attempts`);
  }

  if (result.ok) {
    try {
      await supabasePatch(env, `sims?id=eq.${encodeURIComponent(String(simId))}`, {
        last_notified_at: new Date().toISOString(),
      });
    } catch (err) {
      console.error(`[Webhook] SIM ${simId}: last_notified_at PATCH failed: ${err}`);
    }
  }
}

async function findResellerIdBySimId(env, simId) {
  if (!simId) return null;
  const data = await supabaseSelect(
    env,
    `reseller_sims?select=reseller_id&sim_id=eq.${encodeURIComponent(String(simId))}&active=eq.true&limit=1`
  ).catch(() => null);
  return Array.isArray(data) && data[0]?.reseller_id ? data[0].reseller_id : null;
}

async function findWebhookUrlByResellerId(env, resellerId) {
  if (!resellerId) return null;
  const data = await supabaseSelect(
    env,
    `reseller_webhooks?select=url&reseller_id=eq.${encodeURIComponent(String(resellerId))}&enabled=eq.true&limit=1`
  ).catch(() => null);
  return Array.isArray(data) && data[0]?.url ? data[0].url : null;
}

async function sendWebhookWithDeduplication(env, webhookUrl, payload, options = {}) {
  if (!webhookUrl) return { ok: false, status: 0, attempts: 0, error: 'No webhook URL' };

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

async function generateMessageIdAsync(components) {
  const { eventType, simId, iccid, number, from, body, timestamp } = components;

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
  const data = await supabaseSelect(
    env,
    `webhook_deliveries?message_id=eq.${encodeURIComponent(messageId)}&status=eq.delivered&limit=1`
  ).catch(() => null);
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
      const res = await relayFetch(env, url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      lastStatus = res.status;
      const responseBody = await res.text().catch(() => '');
      if (res.ok) return { ok: true, status: res.status, attempts: attempt, responseBody };
      if (res.status >= 400 && res.status < 500) {
        return { ok: false, status: res.status, attempts: attempt, error: `Client error: ${res.status}`, responseBody };
      }
      lastError = `Server error ${res.status}: ${responseBody.slice(0, 200)}`;
    } catch (err) {
      lastError = `Network error: ${String(err)}`;
      lastStatus = 0;
    }
    if (attempt <= maxRetries) await sleep(initialDelayMs * Math.pow(2, attempt - 1));
  }
  return { ok: false, status: lastStatus, attempts: maxRetries + 1, error: lastError, responseBody: lastError };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function nextRotationUtcISO() {
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

function json(obj) {
  return new Response(JSON.stringify(obj, null, 2), { headers: { 'Content-Type': 'application/json' } });
}
