// SMS-in-24h and Teltik hosting-port stats for the SIMs table.
//
// Two DB-side aggregation RPCs, get_sms_counts_24h and
// get_hosting_port_status_summary, each called in chunks of 500 sim_ids:
// PostgREST caps response rows at 1000, so one call with every sim_id silently
// truncates once more than 1000 SIMs have rows. The two groups depend only on
// the sim id list, so they run together.
//
// Every call is bounded by the shared Supabase transport. A group that fails
// (timeout, network error, non-2xx, a body that is not an array) is reported
// in `unavailable` instead of failing the request, and its fields come back
// null. A SIM with no SMS row still counts 0; only a failed lookup is null, so
// an outage never shows as a fleet of valid zero counts.

import { sbRpc } from '../shared/supabase-rest.mjs';

const CHUNK = 500;

/** @typedef {'sms' | 'hosting_port'} StatSource */

// The derived SIMs-table columns each stats group feeds (see sims-query.mjs).
const SMS_COLUMNS = new Set(['sms_count', 'last_sms_received', 'no_sms_12h']);

/** @param {string} col @returns {StatSource} */
export function statSourceFor(col) {
  return SMS_COLUMNS.has(col) ? 'sms' : 'hosting_port';
}

/** @param {number[]} ids */
function chunkIds(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += CHUNK) out.push(ids.slice(i, i + CHUNK));
  return out;
}

// Every row of `fn` for `ids`, or a thrown Error if any chunk fails, so a
// group is either complete or unavailable, never silently partial.
/** @param {any} env @param {string} fn @param {number[]} ids @returns {Promise<any[]>} */
async function rpcRows(env, fn, ids) {
  const chunks = await Promise.all(chunkIds(ids).map(async (chunk) => {
    const rows = await sbRpc(env, fn, { sim_ids: chunk });
    if (!Array.isArray(rows)) throw new Error(`${fn} returned a non-array body`);
    return rows;
  }));
  return chunks.flat();
}

/**
 * @param {any} env
 * @param {Array<{ id: number, gateway_host?: string | null, vendor?: string | null }>} sims
 * @returns {Promise<{ smsMap: Record<number, { count: number, last_received: string | null }>, hostPortMap: Record<number, any>, unavailable: StatSource[] }>}
 */
export async function loadSimStats(env, sims) {
  const simIds = sims.map(s => s.id);
  const teltikHostedIds = sims
    .filter(s => s.gateway_host === 'teltik' || (!s.gateway_host && s.vendor === 'teltik'))
    .map(s => s.id);

  const [sms, hostPort] = await Promise.allSettled([
    simIds.length ? rpcRows(env, 'get_sms_counts_24h', simIds) : [],
    teltikHostedIds.length ? rpcRows(env, 'get_hosting_port_status_summary', teltikHostedIds) : [],
  ]);

  /** @type {StatSource[]} */
  const unavailable = [];
  /** @type {Record<number, { count: number, last_received: string | null }>} */
  const smsMap = {};
  if (sms.status === 'fulfilled') {
    for (const row of sms.value) smsMap[row.sim_id] = { count: Number(row.sms_count), last_received: row.last_received };
  } else {
    unavailable.push('sms');
    console.error('[sim-stats] get_sms_counts_24h unavailable:', String(sms.reason));
  }

  /** @type {Record<number, any>} */
  const hostPortMap = {};
  if (hostPort.status === 'fulfilled') {
    for (const row of hostPort.value) hostPortMap[row.sim_id] = row;
  } else {
    unavailable.push('hosting_port');
    console.error('[sim-stats] get_hosting_port_status_summary unavailable:', String(hostPort.reason));
  }

  return { smsMap, hostPortMap, unavailable };
}

// The stats fields /api/sims returns for one SIM. `stats_unavailable` names
// the groups whose fields are null because the lookup failed.
/** @param {number} simId @param {Awaited<ReturnType<typeof loadSimStats>>} stats */
export function simStatFields(simId, stats) {
  const smsDown = stats.unavailable.includes('sms');
  const hpDown = stats.unavailable.includes('hosting_port');
  const sms = smsDown ? { count: null, last_received: null } : (stats.smsMap[simId] || { count: 0, last_received: null });
  const hp = stats.hostPortMap[simId] || null;
  const hpCount = (/** @type {string} */ key) => (hpDown ? null : hp ? hp[key] : 0);
  return {
    sms_count: sms.count,
    last_sms_received: sms.last_received,
    hosting_port_state: hp ? hp.last_state : null,
    hosting_port_checked_at: hp ? hp.last_checked_at : null,
    hosting_port_source: hp ? hp.last_source : null,
    hosting_port_mdn: hp ? hp.last_mdn : null,
    hosting_port_mdn_source: hp ? hp.last_mdn_source : null,
    hosting_port_error: hp ? hp.last_error : null,
    hosting_port_checks_24h: hpCount('checks_24h'),
    hosting_port_online_24h: hpCount('online_24h'),
    hosting_port_checks_7d: hpCount('checks_7d'),
    hosting_port_online_7d: hpCount('online_7d'),
    stats_unavailable: stats.unavailable,
  };
}
