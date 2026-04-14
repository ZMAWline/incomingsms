// =========================================================
// DETAILS FINALIZER WORKER
// Cron: every 5 minutes.
// For each provisioning HELIX SIM with a sub_id, calls Helix subscriber_details,
// syncs DB via syncSimFromHelixDetails, then sets status=active once MDN is assigned.
// Note: ATOMIC and Wing IoT SIMs don't need finalization — MDN is assigned at activation.
// =========================================================

import { syncSimFromHelixDetails } from '../shared/subscriber-sync.js';

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
    const result = await runFinalizer(env, limit);
    return json(result);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runFinalizer(env, 25));
  },
};

/* ── Core runner ──────────────────────────────────────────────────────────── */

async function runFinalizer(env, limit) {
  const token = await hxGetBearerToken(env);

  // Only process Helix SIMs - ATOMIC and Wing IoT get MDN at activation time
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
      console.error(`[Finalizer] subId=${subId} iccid=${sim.iccid}: subscriber_details failed: ${e}`);
      errors++;
      continue;
    }

    let synced;
    try {
      synced = await syncSimFromHelixDetails(env, sim, d, { isFinalization: true });
    } catch (e) {
      console.error(`[Finalizer] sim_id=${sim.id}: sync failed: ${e}`);
      errors++;
      continue;
    }

    if (synced.iccidMismatch) {
      // Logged by syncSimFromHelixDetails — skip until manually resolved
      errors++;
      continue;
    }

    if (synced.statusUpdated) {
      // Helix returned suspended/canceled/helix_timeout — DB already updated, do not activate
      console.log(`[Finalizer] sim_id=${sim.id}: Helix status → ${synced.statusUpdated}, skipping activation`);
      continue;
    }

    if (!synced.phoneNumber) {
      // Helix hasn't assigned an MDN yet — will retry on next cron run
      console.log(`[Finalizer] sim_id=${sim.id} iccid=${sim.iccid}: no MDN yet, will retry`);
      continue;
    }

    // MDN is set — activate the SIM
    const activatedAt = synced.activatedAt || sim.activated_at || new Date().toISOString();
    await supabasePatch(
      env,
      `sims?id=eq.${encodeURIComponent(String(sim.id))}`,
      { status: 'active', status_reason: null, activated_at: activatedAt }
    );
    activated++;
    console.log(`[Finalizer] SIM ${sim.iccid} (id=${sim.id}): activated with MDN ${synced.phoneNumber}`);
  }

  return { ok: true, processed, activated, errors };
}

/* ── Helix ────────────────────────────────────────────────────────────────── */

async function hxGetBearerToken(env) {
  const res = await fetch(env.HX_TOKEN_URL, {
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
  const res = await fetch(`${env.HX_API_BASE}/api/mobility-subscriber/details`, {
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

function json(obj) {
  return new Response(JSON.stringify(obj, null, 2), { headers: { 'Content-Type': 'application/json' } });
}
