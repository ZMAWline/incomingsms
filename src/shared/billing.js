// Shared billing math used by both the admin dashboard's invoice preview
// and the reseller-portal's drill-down view. Keeping a single source of
// truth prevents the two from drifting (the math has subtle ordering and
// the Teltik wide-window pagination bug already cost us once).
//
// INC-2: a billing_mode flag selects the engine. Default is 'legacy_simday'
// (the EST-day / 48h-block math below). 'rental' delegates to the forward-only
// flat-rate engine in rentals.js. The flag defaults to legacy everywhere so
// the rental path stays dormant until an explicit, approval-gated cutover.

// Imported lazily inside the rental branch to keep the legacy path free of any
// dependency on rentals.js (and to sidestep the estDateFromDate circular import
// at module-init time — see rentals.js).

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

// Pick the most recent rule active on `day` for a specific vendor scope
// (null = "all AT&T" rule).
function pickActiveRuleForScope(rules, day, scope) {
  let best = null;
  for (const r of rules) {
    if ((r.vendor || null) !== scope) continue;
    if (r.effective_from > day) continue;
    if (r.effective_to && r.effective_to < day) continue;
    if (!best || r.effective_from > best.effective_from) best = r;
  }
  return best;
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

// Resolve the rate for a (day, vendor) bucket. Tier selection uses the
// reseller's TOTAL ACTIVE assigned SIMs of the relevant scope — not the
// daily SMS-billable count — because the price is determined by inventory,
// not usage. Pass the vendor-specific active count and the all-AT&T active
// count; the function picks the appropriate one based on which rule scope
// matched (vendor-specific rule → per-vendor count; vendor=null rule →
// all-AT&T count; Teltik rule → per-vendor count).
function resolveRate(rules, day, vendor, perVendorActive, allAttActive, fallback) {
  if (vendor === 'teltik') {
    const rule = pickActiveRuleForScope(rules, day, 'teltik');
    if (rule) {
      const hit = rateFromRule(rule, perVendorActive);
      if (hit) return { ...hit, tier_input_count: perVendorActive };
    }
    return { rate: fallback, tier: null, rule_id: null, tier_input_count: null };
  }
  const specific = pickActiveRuleForScope(rules, day, vendor);
  if (specific) {
    const hit = rateFromRule(specific, perVendorActive);
    if (hit) return { ...hit, tier_input_count: perVendorActive };
  }
  const allAtt = pickActiveRuleForScope(rules, day, null);
  if (allAtt) {
    const hit = rateFromRule(allAtt, allAttActive);
    if (hit) return { ...hit, tier_input_count: allAttActive };
  }
  return { rate: fallback, tier: null, rule_id: null, tier_input_count: null };
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
export async function computeBillingBreakdown(env, { resellerId, start, end, billing_mode, cutover }) {
  // INC-2: forward-only rental engine, dormant by default. Only the explicit
  // string 'rental' diverts here; anything else (including undefined) runs the
  // legacy EST-day / 48h-block engine below. Lazy import keeps the legacy path
  // free of any rentals.js dependency.
  // `cutover` is an optional override of the forward-only floor (default
  // RENTAL_CUTOVER_DATE). Absent => standard cutover; used only by the test
  // dashboard to diff rental output against an earlier audit window.
  if (billing_mode === 'rental') {
    const { computeRentalBilling } = await import('./rentals.js');
    return computeRentalBilling(env, { resellerId, start, end, cutover });
  }

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

  // attDaysByDateVendor[date][vendor] = Set of sim_ids (billable SIMs-with-SMS per day)
  const attDaysByDateVendor = {};
  // activeByVendor tracks all currently-assigned active SIMs per vendor,
  // regardless of SMS activity. This is the input to tier selection.
  const activeByVendor = { atomic: 0, helix: 0, wing_iot: 0, teltik: 0 };
  const teltikSimIds = [];
  const teltikSmsDaysBySim = new Map();
  const teltikIntervalBySim = new Map();
  if (Array.isArray(rsSims)) {
    for (const rs of rsSims) {
      const vendor = rs.sims?.vendor;
      const daily = rs.sims?.sim_sms_daily;
      if (vendor && Object.prototype.hasOwnProperty.call(activeByVendor, vendor)) {
        activeByVendor[vendor] += 1;
      }
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
  const activeAllAtt = activeByVendor.atomic + activeByVendor.helix + activeByVendor.wing_iot;

  const attEntries = [];
  for (const date of Object.keys(attDaysByDateVendor).sort()) {
    const perVendor = attDaysByDateVendor[date];
    // Compute per-vendor rate decisions. Aggregate when all vendors land on
    // the same rate (legacy behavior preserved when no rules apply).
    const decisions = ATT_VENDORS.map(v => {
      const count = perVendor[v] ? perVendor[v].size : 0;
      if (count === 0) return null;
      const decided = resolveRate(rules, date, v, activeByVendor[v], activeAllAtt, dailyRate);
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
      if (decisions[0].tier_input_count != null) entry.tier_input_count = decisions[0].tier_input_count;
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
        if (d.tier_input_count != null) entry.tier_input_count = d.tier_input_count;
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
    const decided = resolveRate(rules, date, 'teltik', activeByVendor.teltik, 0, blockRate);
    const entry = {
      date,
      vendor: 'teltik',
      sim_count: count,
      rate: decided.rate,
      amount: +(count * decided.rate).toFixed(2),
    };
    if (decided.tier) entry.tier = decided.tier;
    if (decided.rule_id) entry.rule_id = decided.rule_id;
    if (decided.tier_input_count != null) entry.tier_input_count = decided.tier_input_count;
    return entry;
  });

  const days = [...attEntries, ...teltikEntries].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  const totalSimDays = days.reduce((s, d) => s + d.sim_count, 0);
  const totalAmount = +(days.reduce((s, d) => s + d.amount, 0)).toFixed(2);

  return {
    reseller_id: resellerId,
    reseller_name: reseller?.name || resellerId,
    billing_mode: 'legacy_simday',
    mapping,
    daily_rate: dailyRate,
    block_rate: blockRate,
    days,
    total_sim_days: totalSimDays,
    total_amount: totalAmount,
    rules_applied: rules.length > 0,
    active_counts: {
      atomic: activeByVendor.atomic,
      helix: activeByVendor.helix,
      wing_iot: activeByVendor.wing_iot,
      teltik: activeByVendor.teltik,
      all_att: activeAllAtt,
    },
  };
}

// Read-only utilization audit. For a reseller and a window [start, end] (EST
// dates), counts how many of their currently-active assigned SIMs received
// at least one inbound SMS during the window, per vendor. Returns the idle
// SIM list so the operator can see exactly which ICCIDs went dark.
//
// "Active in window" = any sim_sms_daily row in [start, end] with sms_count>0.
// This is a coarser predicate than billing's per-rotation-block check — a SIM
// active on a window-edge day of an unrotated block would count here but not
// bill. Acceptable for the question "is the customer using these SIMs?".
export async function computeResellerUtilization(env, { resellerId, start, end, vendors }) {
  const vendorList = (Array.isArray(vendors) && vendors.length)
    ? vendors
    : ['teltik', 'atomic', 'helix', 'wing_iot'];

  const rsRows = await sbGetAll(env,
    'reseller_sims?select=sim_id,created_at,sims!inner(id,iccid,vendor,status,rotation_interval_hours,' +
    'sim_numbers(e164,valid_to),' +
    'sim_sms_daily(est_date,sms_count))' +
    '&reseller_id=eq.' + encodeURIComponent(resellerId) +
    '&active=eq.true' +
    '&sims.status=eq.active' +
    '&sims.vendor=in.(' + vendorList.map(encodeURIComponent).join(',') + ')' +
    '&order=sim_id.asc'
  );

  const byVendor = new Map(); // vendor -> { total_active, active_in_window, idle: [], all: [] }
  for (const v of vendorList) byVendor.set(v, { total_active: 0, active_in_window: 0, idle: [], all: [] });

  // For Teltik block-level computation we need per-SIM smsDays Set + interval.
  const allSmsDaysBySim = new Map();
  const teltikIntervalBySim = new Map();
  const teltikRecordById = new Map();

  for (const rs of (Array.isArray(rsRows) ? rsRows : [])) {
    const sim = rs.sims;
    if (!sim || !byVendor.has(sim.vendor)) continue;
    const bucket = byVendor.get(sim.vendor);
    bucket.total_active += 1;

    // Current MDN: sim_numbers row with valid_to=null
    let currentE164 = null;
    if (Array.isArray(sim.sim_numbers)) {
      for (const n of sim.sim_numbers) {
        if (n && n.valid_to == null) { currentE164 = n.e164; break; }
      }
    }

    // SMS aggregation
    let smsDaysInWindow = 0;
    let smsTotalInWindow = 0;
    let lastSmsDate = null;
    const allDays = new Set();
    if (Array.isArray(sim.sim_sms_daily)) {
      for (const row of sim.sim_sms_daily) {
        if (!row || !row.est_date || !(row.sms_count > 0)) continue;
        allDays.add(row.est_date);
        if (lastSmsDate == null || row.est_date > lastSmsDate) lastSmsDate = row.est_date;
        if (row.est_date >= start && row.est_date <= end) {
          smsDaysInWindow += 1;
          smsTotalInWindow += Number(row.sms_count) || 0;
        }
      }
    }
    allSmsDaysBySim.set(sim.id, allDays);

    const record = {
      sim_id: sim.id,
      iccid: sim.iccid,
      current_e164: currentE164,
      last_sms_date: lastSmsDate,
      sms_days_in_window: smsDaysInWindow,
      sms_total_in_window: smsTotalInWindow,
      assigned_since: rs.created_at || null,
      // Block-level (populated below for Teltik only)
      blocks_in_window: null,
      blocks_billed: null,
      blocks_idle: null,
      block_utilization_pct: null,
      idle_block_dates: null,
    };
    bucket.all.push(record);
    if (smsDaysInWindow > 0) bucket.active_in_window += 1;
    else bucket.idle.push(record);

    if (sim.vendor === 'teltik') {
      teltikIntervalBySim.set(sim.id, sim.rotation_interval_hours || 48);
      teltikRecordById.set(sim.id, record);
    }
  }

  // Block-level for Teltik. Mirrors computeBillingBreakdown's block iteration:
  // a block = one rotation event (sim_numbers.valid_from); it's billable iff
  // any covered EST day had SMS. Fetch rotations in a wider window so blocks
  // straddling the edges are accounted for.
  const teltikBucket = byVendor.get('teltik');
  if (teltikBucket && teltikRecordById.size > 0) {
    const teltikSimIds = Array.from(teltikRecordById.keys());
    const wideStart = new Date(start + 'T00:00:00Z');
    wideStart.setUTCDate(wideStart.getUTCDate() - 2);
    const wideEnd = new Date(end + 'T00:00:00Z');
    wideEnd.setUTCDate(wideEnd.getUTCDate() + 3);
    const rotations = await sbGetAll(env,
      'sim_numbers?select=sim_id,valid_from&sim_id=in.(' + teltikSimIds.join(',') + ')' +
      '&valid_from=gte.' + encodeURIComponent(wideStart.toISOString()) +
      '&valid_from=lt.' + encodeURIComponent(wideEnd.toISOString()) +
      '&order=sim_id.asc,valid_from.asc'
    );

    const rotsBySim = new Map();
    for (const r of (Array.isArray(rotations) ? rotations : [])) {
      if (!rotsBySim.has(r.sim_id)) rotsBySim.set(r.sim_id, []);
      rotsBySim.get(r.sim_id).push(new Date(r.valid_from));
    }

    let totalBlocks = 0, billedBlocks = 0;
    for (const [simId, rec] of teltikRecordById) {
      const rots = rotsBySim.get(simId) || [];
      const intervalMs = (teltikIntervalBySim.get(simId) || 48) * 3600 * 1000;
      const smsDays = allSmsDaysBySim.get(simId) || new Set();
      let blocksInWindow = 0, billed = 0;
      const idleDates = [];
      for (let i = 0; i < rots.length; i++) {
        const rotStart = rots[i];
        const rotNext = rots[i + 1];
        const blockEnd = new Date(Math.min(
          rotStart.getTime() + intervalMs,
          rotNext ? rotNext.getTime() : Number.POSITIVE_INFINITY
        ));
        const startEst = estDateFromDate(rotStart);
        if (startEst < start || startEst > end) continue;
        blocksInWindow += 1;
        const endEstInclusive = estDateFromDate(new Date(blockEnd.getTime() - 1000));
        let hasSms = false;
        for (let cur = startEst; cur <= endEstInclusive; cur = nextEstDate(cur)) {
          if (smsDays.has(cur)) { hasSms = true; break; }
        }
        if (hasSms) billed += 1;
        else idleDates.push(startEst);
      }
      rec.blocks_in_window = blocksInWindow;
      rec.blocks_billed = billed;
      rec.blocks_idle = blocksInWindow - billed;
      rec.block_utilization_pct = blocksInWindow > 0
        ? +(billed / blocksInWindow * 100).toFixed(1)
        : null;
      rec.idle_block_dates = idleDates;
      totalBlocks += blocksInWindow;
      billedBlocks += billed;
    }

    teltikBucket.total_blocks = totalBlocks;
    teltikBucket.billed_blocks = billedBlocks;
    teltikBucket.idle_blocks = totalBlocks - billedBlocks;
    teltikBucket.block_utilization_pct = totalBlocks > 0
      ? +(billedBlocks / totalBlocks * 100).toFixed(1)
      : null;
  }

  const result = [];
  for (const v of vendorList) {
    const b = byVendor.get(v);
    // Sort idle list: never-used first, then oldest last_sms_date first
    b.idle.sort((a, b2) => {
      if (a.last_sms_date == null && b2.last_sms_date != null) return -1;
      if (a.last_sms_date != null && b2.last_sms_date == null) return 1;
      if (a.last_sms_date == null && b2.last_sms_date == null) return 0;
      return a.last_sms_date < b2.last_sms_date ? -1 : a.last_sms_date > b2.last_sms_date ? 1 : 0;
    });
    // For Teltik, also sort `all` by blocks_idle DESC (worst first) so the
    // dashboard table surfaces underutilized SIMs at the top.
    if (v === 'teltik') {
      b.all.sort((a, b2) => (b2.blocks_idle || 0) - (a.blocks_idle || 0));
    }
    result.push({
      vendor: v,
      total_active: b.total_active,
      active_in_window: b.active_in_window,
      idle_count: b.total_active - b.active_in_window,
      utilization_pct: b.total_active > 0
        ? +(b.active_in_window / b.total_active * 100).toFixed(1)
        : null,
      // Teltik-only block-level fields (null for AT&T vendors):
      total_blocks: b.total_blocks != null ? b.total_blocks : null,
      billed_blocks: b.billed_blocks != null ? b.billed_blocks : null,
      idle_blocks: b.idle_blocks != null ? b.idle_blocks : null,
      block_utilization_pct: b.block_utilization_pct != null ? b.block_utilization_pct : null,
      idle: b.idle,
      all: b.all,
    });
  }

  return {
    reseller_id: resellerId,
    start,
    end,
    vendors: result,
  };
}
