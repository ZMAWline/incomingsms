/**
 * syncSimFromHelixDetails — universal Helix → DB sync
 *
 * Call this any time subscriber_details is fetched from Helix.
 * Syncs everything except status (status is governed by OTA refresh).
 *
 * Rules:
 *   ICCID mismatch → log error, skip MDN sync, do not auto-fix
 *   IMEI mismatch  → log warning, do not auto-fix
 *   MDN sync       → only during finalization (provisioning SIMs); for active SIMs, log mismatch only
 *   activated_at   → backfill from Helix if DB is null
 *
 * @param {object} env - Worker env (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
 * @param {object} simRow - DB row: { id, iccid, status, imei, activated_at, mobility_subscription_id }
 * @param {object} d - Single Helix subscriber_details entry (not the array wrapper)
 * @param {object} [opts]
 * @param {boolean} [opts.isFinalization] - true when finalizing provisioning→active
 * @returns {{ phoneNumber: string|null, activatedAt: string|null, iccidMismatch: boolean, imeiMismatch: boolean }}
 */
export async function syncSimFromHelixDetails(env, simRow, d, { isFinalization = false } = {}) {
  const result = { phoneNumber: null, activatedAt: null, iccidMismatch: false, imeiMismatch: false, statusUpdated: null };
  if (!d) return result;

  // 1. ICCID verification — log if mismatch, do not auto-fix
  const helixIccid = d.iccid ? String(d.iccid).trim() : null;
  if (helixIccid && helixIccid !== simRow.iccid) {
    console.error(
      `[SyncDetails] ICCID MISMATCH sim_id=${simRow.id}: DB=${simRow.iccid} Helix=${helixIccid} ` +
      `subId=${simRow.mobility_subscription_id} — not auto-fixing`
    );
    result.iccidMismatch = true;
    // Skip MDN sync — this data belongs to a different SIM
    return result;
  }

  // 2. Status sync from subscriber_details
  //    - helix_timeout: statusReason contains "Timed Out"
  //    - suspended / canceled: sync to DB
  //    - active: no change (governed by OTA / finalization)
  {
    const helixStatusRaw = d?.status ? String(d.status) : null;
    const statusReason = d?.statusReason ? String(d.statusReason).toLowerCase() : null;
    let newDbStatus = null;
    if (statusReason && statusReason.includes('timed out')) {
      newDbStatus = 'helix_timeout';
    } else if (helixStatusRaw) {
      const lower = helixStatusRaw.toLowerCase();
      if (lower === 'suspended') newDbStatus = 'suspended';
      else if (lower === 'canceled' || lower === 'cancelled') newDbStatus = 'canceled';
    }
    if (newDbStatus && newDbStatus !== simRow.status) {
      await _patch(env, `sims?id=eq.${encodeURIComponent(String(simRow.id))}`, { status: newDbStatus });
      console.log(`[SyncDetails] sim_id=${simRow.id}: status → ${newDbStatus} (Helix: ${helixStatusRaw}, reason: ${d?.statusReason})`);
      result.statusUpdated = newDbStatus;
    }
  }

  // 4. activated_at — backfill from Helix if DB is missing it
  if (d.activatedAt && !simRow.activated_at) {
    const ts = new Date(d.activatedAt).toISOString();
    await _patch(env, `sims?id=eq.${encodeURIComponent(String(simRow.id))}`, { activated_at: ts });
    result.activatedAt = ts;
    console.log(`[SyncDetails] sim_id=${simRow.id}: backfilled activated_at=${ts}`);
  }

  // 4b. att_ban — store/update from Helix if present
  const helixBan = d?.attBan || d?.ban || null;
  if (helixBan) {
    await _patch(env, `sims?id=eq.${encodeURIComponent(String(simRow.id))}`, { att_ban: helixBan });
    console.log(`[SyncDetails] sim_id=${simRow.id}: stored att_ban=${helixBan}`);
  }

  // 5. IMEI check — log only, do not auto-fix
  const helixImei = d.billingImei ? String(d.billingImei).trim() : null;
  if (helixImei && simRow.imei && helixImei !== simRow.imei) {
    console.warn(
      `[SyncDetails] IMEI mismatch sim_id=${simRow.id}: DB=${simRow.imei} Helix=${helixImei} — not auto-fixing`
    );
    result.imeiMismatch = true;
  }

  // 6. MDN — normalize Helix phoneNumber
  const helixPhone = d.phoneNumber ? String(d.phoneNumber).replace(/\D/g, '') : null;
  if (!helixPhone) return result;

  const e164 = helixPhone.length === 10 ? `+1${helixPhone}`
    : helixPhone.length === 11 && helixPhone.startsWith('1') ? `+${helixPhone}`
    : null;

  if (!e164) {
    console.warn(`[SyncDetails] sim_id=${simRow.id}: unrecognized phone format: ${d.phoneNumber}`);
    return result;
  }

  result.phoneNumber = e164;

  if (!isFinalization && simRow.status !== 'provisioning') {
    // Active/suspended SIMs: check and log MDN discrepancy only — do not modify sim_numbers
    const rows = await _select(env, `sim_numbers?sim_id=eq.${simRow.id}&valid_to=is.null&order=valid_from.desc&limit=1`);
    const currentMdn = rows?.[0]?.e164;
    if (currentMdn && currentMdn !== e164) {
      console.warn(
        `[SyncDetails] MDN mismatch sim_id=${simRow.id}: DB=${currentMdn} Helix=${e164} — not auto-fixing`
      );
    }
    return result;
  }

  // Finalization mode: close old number (if any) and insert new one
  const rows = await _select(env, `sim_numbers?sim_id=eq.${simRow.id}&valid_to=is.null&order=valid_from.desc&limit=1`);
  const currentMdn = rows?.[0]?.e164;

  if (currentMdn === e164) {
    // Already correct
    return result;
  }

  if (currentMdn) {
    await _patch(env, `sim_numbers?sim_id=eq.${simRow.id}&valid_to=is.null`, {
      valid_to: new Date().toISOString(),
    });
  }

  await _insert(env, 'sim_numbers', [{
    sim_id: simRow.id,
    e164,
    valid_from: new Date().toISOString(),
    verification_status: 'verified',
  }]);

  console.log(
    `[SyncDetails] sim_id=${simRow.id}: MDN set to ${e164}` +
    (currentMdn ? ` (was ${currentMdn})` : ' (first number)')
  );

  return result;
}

// ── Minimal Supabase helpers (private to this module) ────────────────────────

async function _select(env, path) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`Supabase SELECT ${res.status}: ${await res.text().catch(() => '')}`);
  return res.json();
}

async function _patch(env, path, body) {
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

async function _insert(env, table, rows) {
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
