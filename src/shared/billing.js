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

const ATT_VENDORS = ['atomic', 'helix', 'wing_iot'];

// Pick the most recent rule active on `day` for the given vendor scope.
// AT&T vendors fall back to vendor=null rules; Teltik does not (different unit).
function pickActiveRule(rules, day, vendor) {
  const order = vendor === 'teltik' ? ['teltik'] : [vendor, null];
  for (const scope of order) {
    let best = null;
    for (const r of rules) {
      if ((r.vendor || null) !== scope) continue;
      if (r.effective_from > day) continue;
      if (r.effective_to && r.effective_to < day) continue;
      if (!best || r.effective_from > best.effective_from) best = r;
    }
    if (best) return best;
  }
  return null;
}

function rateFromRule(rule, count) {
  if (!rule || !Array.isArray(rule.tiers)) return null;
  const sorted = [...rule.tiers].sort((a, b) => (Number(a.min_count) || 0) - (Number(b.min_count) || 0));
  for (const t of sorted) {
    const min = Number(t.min_count) || 0;
    const max = (t.max_count == null || t.max_count === '') ? Infinity : Number(t.max_count);
    if (count >= min && count <= max) {
      return {
        rate: parseFloat(t.rate),
        tier: { min_count: min, max_count: max === Infinity ? null : max, rate: parseFloat(t.rate) },
        rule_id: rule.id,
      };
    }
  }
  return null;
}

// Resolve the rate for a single (day, vendor, count). Returns
// { rate, tier?, rule_id? } with `rate` always populated (falls back to default).
function resolveRate(rules, day, vendor, count, fallback) {
  const rule = pickActiveRule(rules, day, vendor);
  if (rule) {
    const hit = rateFromRule(rule, count);
    if (hit) return hit;
  }
  return { rate: fallback, tier: null, rule_id: null };
}

// Mirrors handleBillingPreview in src/dashboard/index.js exactly.
// AT&T (helix/atomic/wing_iot): one SIM-day at dailyRate per (sim, EST date)
//   where sim_sms_daily.sms_count > 0 and date in [start, end].
// Teltik: one block at 2*dailyRate per sim_numbers.valid_from whose EST
//   date is in [start, end], iff any covered EST day has SMS for that sim.
//   Block range = [valid_from, min(valid_from + rotation_interval_hours, next valid_from)).
//
// Volume tiers: if reseller_rates rows match a given (date, vendor), the rate
// for that bucket is chosen by tier (all-at-rate). AT&T vendors aggregate
// into a single per-date entry when they all resolve to the same rate
// (preserves legacy output shape for resellers with no rules).
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

  const rules = await sbGetAll(env,
    'reseller_rates?select=id,vendor,effective_from,effective_to,tiers' +
    '&reseller_id=eq.' + encodeURIComponent(resellerId) +
    '&effective_from=lte.' + end +
    '&or=(effective_to.is.null,effective_to.gte.' + start + ')'
  );

  const dailyRate = mapping ? parseFloat(mapping.daily_rate) : 0;
  const blockRate = +(dailyRate * 2).toFixed(2);

  // attDaysByDateVendor[date][vendor] = Set of sim_ids
  const attDaysByDateVendor = {};
  const teltikSimIds = [];
  const teltikSmsDaysBySim = new Map();
  const teltikIntervalBySim = new Map();
  if (Array.isArray(rsSims)) {
    for (const rs of rsSims) {
      const vendor = rs.sims?.vendor;
      const daily = rs.sims?.sim_sms_daily;
      if (vendor === 'teltik') {
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
      if (!ATT_VENDORS.includes(vendor)) continue;
      if (!Array.isArray(daily)) continue;
      for (const row of daily) {
        if (!row.est_date || row.sms_count <= 0) continue;
        if (row.est_date < start || row.est_date > end) continue;
        if (!attDaysByDateVendor[row.est_date]) attDaysByDateVendor[row.est_date] = {};
        if (!attDaysByDateVendor[row.est_date][vendor]) attDaysByDateVendor[row.est_date][vendor] = new Set();
        attDaysByDateVendor[row.est_date][vendor].add(rs.sim_id);
      }
    }
  }

  const attEntries = [];
  for (const date of Object.keys(attDaysByDateVendor).sort()) {
    const perVendor = attDaysByDateVendor[date];
    // Compute per-vendor rate decisions. Aggregate when all vendors land on
    // the same rate (legacy behavior preserved when no rules apply).
    const decisions = ATT_VENDORS.map(v => {
      const count = perVendor[v] ? perVendor[v].size : 0;
      if (count === 0) return null;
      const decided = resolveRate(rules, date, v, count, dailyRate);
      return { vendor: v, count, ...decided };
    }).filter(Boolean);
    if (decisions.length === 0) continue;
    const allSameRate = decisions.every(d => d.rate === decisions[0].rate && d.rule_id === decisions[0].rule_id);
    if (allSameRate) {
      const totalCount = decisions.reduce((s, d) => s + d.count, 0);
      const entry = {
        date,
        sim_count: totalCount,
        rate: decisions[0].rate,
        amount: +(totalCount * decisions[0].rate).toFixed(2),
      };
      if (decisions[0].tier) entry.tier = decisions[0].tier;
      if (decisions[0].rule_id) entry.rule_id = decisions[0].rule_id;
      attEntries.push(entry);
    } else {
      for (const d of decisions) {
        const entry = {
          date,
          vendor: d.vendor,
          sim_count: d.count,
          rate: d.rate,
          amount: +(d.count * d.rate).toFixed(2),
        };
        if (d.tier) entry.tier = d.tier;
        if (d.rule_id) entry.rule_id = d.rule_id;
        attEntries.push(entry);
      }
    }
  }

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

  const teltikEntries = Object.keys(teltikBlocks).sort().map(date => {
    const count = teltikBlocks[date];
    const decided = resolveRate(rules, date, 'teltik', count, blockRate);
    const entry = {
      date,
      vendor: 'teltik',
      sim_count: count,
      rate: decided.rate,
      amount: +(count * decided.rate).toFixed(2),
    };
    if (decided.tier) entry.tier = decided.tier;
    if (decided.rule_id) entry.rule_id = decided.rule_id;
    return entry;
  });

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
    rules_applied: rules.length > 0,
  };
}
