// Shared billing math used by both the admin dashboard's invoice preview
// and the reseller-portal's drill-down view. Keeping a single source of
// truth prevents the two from drifting (the math has subtle ordering and
// the Teltik wide-window pagination bug already cost us once).

export function estDateFromDate(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
}

export function nextEstDate(yyyyMmDd) {
  const t = new Date(yyyyMmDd + 'T12:00:00Z');
  t.setUTCDate(t.getUTCDate() + 1);
  return estDateFromDate(t);
}

async function sbGet(env, path) {
  return fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      Accept: 'application/json',
    },
  });
}

async function sbGetAll(env, pathWithoutLimit) {
  const pageSize = 1000;
  const out = [];
  for (let offset = 0; ; offset += pageSize) {
    const sep = pathWithoutLimit.includes('?') ? '&' : '?';
    const url = pathWithoutLimit + sep + 'limit=' + pageSize + '&offset=' + offset;
    const resp = await sbGet(env, url);
    if (!resp.ok) throw new Error('PostgREST fetch failed: ' + resp.status + ' ' + (await resp.text()));
    const batch = await resp.json();
    if (!Array.isArray(batch)) return batch;
    out.push(...batch);
    if (batch.length < pageSize) break;
  }
  return out;
}

// Mirrors handleBillingPreview in src/dashboard/index.js exactly.
// AT&T (helix/atomic/wing_iot): one SIM-day at dailyRate per (sim, EST date)
//   where sim_sms_daily.sms_count > 0 and date in [start, end].
// Teltik: one block at 2*dailyRate per sim_numbers.valid_from whose EST
//   date is in [start, end], iff any covered EST day has SMS for that sim.
//   Block range = [valid_from, min(valid_from + rotation_interval_hours, next valid_from)).
export async function computeBillingBreakdown(env, { resellerId, start, end }) {
  const [resellerResp, mappingResp] = await Promise.all([
    sbGet(env, 'resellers?select=id,name&id=eq.' + encodeURIComponent(resellerId) + '&limit=1'),
    sbGet(env, 'qbo_customer_map?select=id,qbo_customer_id,qbo_display_name,daily_rate&reseller_id=eq.' + encodeURIComponent(resellerId) + '&limit=1'),
  ]);
  const resellerData = await resellerResp.json();
  const mappingData = await mappingResp.json();
  const reseller = Array.isArray(resellerData) && resellerData[0] ? resellerData[0] : null;
  const mapping = Array.isArray(mappingData) && mappingData[0] ? mappingData[0] : null;

  const rsSims = await sbGetAll(env,
    'reseller_sims?select=sim_id,sims(vendor,rotation_interval_hours,sim_sms_daily(est_date,sms_count))' +
    '&reseller_id=eq.' + encodeURIComponent(resellerId) +
    '&active=eq.true' +
    '&order=sim_id.asc'
  );

  const dailyRate = mapping ? parseFloat(mapping.daily_rate) : 0;
  const blockRate = +(dailyRate * 2).toFixed(2);

  const attDays = {};
  const teltikSimIds = [];
  const teltikSmsDaysBySim = new Map();
  const teltikIntervalBySim = new Map();
  if (Array.isArray(rsSims)) {
    for (const rs of rsSims) {
      const daily = rs.sims?.sim_sms_daily;
      if (rs.sims?.vendor === 'teltik') {
        teltikSimIds.push(rs.sim_id);
        teltikIntervalBySim.set(rs.sim_id, rs.sims?.rotation_interval_hours || 48);
        const days = new Set();
        if (Array.isArray(daily)) {
          for (const row of daily) {
            if (row.est_date && row.sms_count > 0) days.add(row.est_date);
          }
        }
        teltikSmsDaysBySim.set(rs.sim_id, days);
        continue;
      }
      if (!Array.isArray(daily)) continue;
      for (const row of daily) {
        if (!row.est_date || row.sms_count <= 0) continue;
        if (row.est_date < start || row.est_date > end) continue;
        if (!attDays[row.est_date]) attDays[row.est_date] = new Set();
        attDays[row.est_date].add(rs.sim_id);
      }
    }
  }

  const attEntries = Object.keys(attDays).sort().map(date => ({
    date, sim_count: attDays[date].size, rate: dailyRate,
    amount: +(attDays[date].size * dailyRate).toFixed(2),
  }));

  const teltikBlocks = {};
  if (teltikSimIds.length > 0) {
    const wideStart = new Date(start + 'T00:00:00Z');
    wideStart.setUTCDate(wideStart.getUTCDate() - 2);
    const wideEnd = new Date(end + 'T00:00:00Z');
    wideEnd.setUTCDate(wideEnd.getUTCDate() + 3);
    const idList = teltikSimIds.join(',');
    const rotations = await sbGetAll(env,
      'sim_numbers?select=sim_id,valid_from&sim_id=in.(' + idList + ')' +
      '&valid_from=gte.' + encodeURIComponent(wideStart.toISOString()) +
      '&valid_from=lt.' + encodeURIComponent(wideEnd.toISOString()) +
      '&order=sim_id.asc,valid_from.asc'
    );
    if (Array.isArray(rotations)) {
      const byThen = new Map();
      for (const r of rotations) {
        if (!byThen.has(r.sim_id)) byThen.set(r.sim_id, []);
        byThen.get(r.sim_id).push(new Date(r.valid_from));
      }
      for (const [simId, rots] of byThen) {
        const intervalMs = (teltikIntervalBySim.get(simId) || 48) * 3600 * 1000;
        for (let i = 0; i < rots.length; i++) {
          const rotStart = rots[i];
          const rotNext = rots[i + 1];
          const blockEnd = new Date(Math.min(
            rotStart.getTime() + intervalMs,
            rotNext ? rotNext.getTime() : Number.POSITIVE_INFINITY
          ));
          const startEst = estDateFromDate(rotStart);
          if (startEst < start || startEst > end) continue;
          const endEstInclusive = estDateFromDate(new Date(blockEnd.getTime() - 1000));
          const daysSet = teltikSmsDaysBySim.get(simId) || new Set();
          let hasSms = false;
          for (let cur = startEst; cur <= endEstInclusive; cur = nextEstDate(cur)) {
            if (daysSet.has(cur)) { hasSms = true; break; }
          }
          if (!hasSms) continue;
          if (!teltikBlocks[startEst]) teltikBlocks[startEst] = 0;
          teltikBlocks[startEst] += 1;
        }
      }
    }
  }

  const teltikEntries = Object.keys(teltikBlocks).sort().map(date => ({
    date, sim_count: teltikBlocks[date], rate: blockRate,
    amount: +(teltikBlocks[date] * blockRate).toFixed(2),
  }));

  const days = [...attEntries, ...teltikEntries].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  const totalSimDays = days.reduce((s, d) => s + d.sim_count, 0);
  const totalAmount = +(days.reduce((s, d) => s + d.amount, 0)).toFixed(2);

  return {
    reseller_id: resellerId,
    reseller_name: reseller?.name || resellerId,
    mapping,
    daily_rate: dailyRate,
    block_rate: blockRate,
    days,
    total_sim_days: totalSimDays,
    total_amount: totalAmount,
  };
}
