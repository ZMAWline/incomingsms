// _fix_teltik_rotation_blocks.js
// Teltik billing: replace day-pair-from-cycle-start logic with rotation-aligned
// blocks. Block = [valid_from, min(next_rotation, valid_from + rotation_interval_hours)).
// Block bills into the cycle containing valid_from's EST date.
//
// Three edits:
//   1. Add estDateFromDate / nextEstDate helpers after todayEst().
//   2. Rewrite teltik section in handleBillingPreview.
//   3. Rewrite teltik section in handleBillingDownloadInvoice.

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

// ---------- 1. Add helpers after todayEst() ----------
const HELPER_OLD =
  "function todayEst(now = new Date()) {\n" +
  "  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now);\n" +
  "}\n";

const HELPER_NEW =
  HELPER_OLD +
  "\n" +
  "function estDateFromDate(d) {\n" +
  "  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);\n" +
  "}\n" +
  "\n" +
  "function nextEstDate(yyyyMmDd) {\n" +
  "  const t = new Date(yyyyMmDd + 'T12:00:00Z');\n" +
  "  t.setUTCDate(t.getUTCDate() + 1);\n" +
  "  return estDateFromDate(t);\n" +
  "}\n";

if (!content.includes(HELPER_OLD)) {
  console.error('PATCH FAILED: todayEst() anchor not found.');
  process.exit(1);
}
if (content.includes('function estDateFromDate(')) {
  console.log('Helpers already present — skipping helper insertion.');
} else {
  content = content.replace(HELPER_OLD, HELPER_NEW);
}

// ---------- 2. handleBillingPreview teltik section ----------
const PREVIEW_OLD =
  "      'reseller_sims?select=sim_id,sims(vendor,sim_sms_daily(est_date,sms_count))' +\n" +
  "      '&reseller_id=eq.' + encodeURIComponent(resellerId) +\n" +
  "      '&active=eq.true' +\n" +
  "      '&limit=5000'\n" +
  "    );\n" +
  "    const rsSims = await smsResp.json();\n" +
  "\n" +
  "    // Collect active days by vendor (Helix=daily billing, Teltik=48h block billing)\n" +
  "    const dailyRate = mapping ? parseFloat(mapping.daily_rate) : 0;\n" +
  "    const blockRate = +(dailyRate * 2).toFixed(2);\n" +
  "    const attDays = {}; // est_date → Set of sim_ids (AT&T: helix + atomic + wing_iot)\n" +
  "    const teltikDays = {}; // est_date → Set of sim_ids (T-Mobile: teltik)\n" +
  "    if (Array.isArray(rsSims)) {\n" +
  "      for (const rs of rsSims) {\n" +
  "        const daily = rs.sims?.sim_sms_daily;\n" +
  "        if (!Array.isArray(daily)) continue;\n" +
  "        const target = rs.sims?.vendor === 'teltik' ? teltikDays : attDays;\n" +
  "        for (const row of daily) {\n" +
  "          if (!row.est_date || row.sms_count <= 0) continue;\n" +
  "          if (row.est_date < start || row.est_date > end) continue;\n" +
  "          if (!target[row.est_date]) target[row.est_date] = new Set();\n" +
  "          target[row.est_date].add(rs.sim_id);\n" +
  "        }\n" +
  "      }\n" +
  "    }\n" +
  "\n" +
  "    // AT&T (helix/atomic/wing): bill per calendar day at dailyRate\n" +
  "    const attEntries = Object.keys(attDays).sort().map(date => ({\n" +
  "      date, sim_count: attDays[date].size, rate: dailyRate,\n" +
  "      amount: +(attDays[date].size * dailyRate).toFixed(2),\n" +
  "    }));\n" +
  "\n" +
  "    // Teltik: bill per 48-hour block at blockRate\n" +
  "    const teltikBlocks = {};\n" +
  "    for (let bs = start; bs <= end; ) {\n" +
  "      const d0 = bs;\n" +
  "      const tmp = new Date(d0 + 'T00:00:00Z');\n" +
  "      tmp.setUTCDate(tmp.getUTCDate() + 1);\n" +
  "      const d1 = tmp.toISOString().slice(0, 10);\n" +
  "      const simsInBlock = new Set();\n" +
  "      for (const [date, sims] of Object.entries(teltikDays)) {\n" +
  "        if (date === d0 || date === d1) { for (const s of sims) simsInBlock.add(s); }\n" +
  "      }\n" +
  "      if (simsInBlock.size > 0) teltikBlocks[d0] = simsInBlock;\n" +
  "      tmp.setUTCDate(tmp.getUTCDate() + 1);\n" +
  "      bs = tmp.toISOString().slice(0, 10);\n" +
  "    }\n" +
  "    const teltikEntries = Object.keys(teltikBlocks).sort().map(date => ({\n" +
  "      date, sim_count: teltikBlocks[date].size, rate: blockRate,\n" +
  "      amount: +(teltikBlocks[date].size * blockRate).toFixed(2),\n" +
  "    }));\n";

const PREVIEW_NEW =
  "      'reseller_sims?select=sim_id,sims(vendor,rotation_interval_hours,sim_sms_daily(est_date,sms_count))' +\n" +
  "      '&reseller_id=eq.' + encodeURIComponent(resellerId) +\n" +
  "      '&active=eq.true' +\n" +
  "      '&limit=5000'\n" +
  "    );\n" +
  "    const rsSims = await smsResp.json();\n" +
  "\n" +
  "    const dailyRate = mapping ? parseFloat(mapping.daily_rate) : 0;\n" +
  "    const blockRate = +(dailyRate * 2).toFixed(2);\n" +
  "\n" +
  "    // AT&T (helix/atomic/wing): per-calendar-day at dailyRate.\n" +
  "    // Teltik: one block per MDN rotation; handled after AT&T.\n" +
  "    const attDays = {};\n" +
  "    const teltikSimIds = [];\n" +
  "    const teltikSmsDaysBySim = new Map();\n" +
  "    const teltikIntervalBySim = new Map();\n" +
  "    if (Array.isArray(rsSims)) {\n" +
  "      for (const rs of rsSims) {\n" +
  "        const daily = rs.sims?.sim_sms_daily;\n" +
  "        if (rs.sims?.vendor === 'teltik') {\n" +
  "          teltikSimIds.push(rs.sim_id);\n" +
  "          teltikIntervalBySim.set(rs.sim_id, rs.sims?.rotation_interval_hours || 48);\n" +
  "          const days = new Set();\n" +
  "          if (Array.isArray(daily)) {\n" +
  "            for (const row of daily) {\n" +
  "              if (row.est_date && row.sms_count > 0) days.add(row.est_date);\n" +
  "            }\n" +
  "          }\n" +
  "          teltikSmsDaysBySim.set(rs.sim_id, days);\n" +
  "          continue;\n" +
  "        }\n" +
  "        if (!Array.isArray(daily)) continue;\n" +
  "        for (const row of daily) {\n" +
  "          if (!row.est_date || row.sms_count <= 0) continue;\n" +
  "          if (row.est_date < start || row.est_date > end) continue;\n" +
  "          if (!attDays[row.est_date]) attDays[row.est_date] = new Set();\n" +
  "          attDays[row.est_date].add(rs.sim_id);\n" +
  "        }\n" +
  "      }\n" +
  "    }\n" +
  "\n" +
  "    const attEntries = Object.keys(attDays).sort().map(date => ({\n" +
  "      date, sim_count: attDays[date].size, rate: dailyRate,\n" +
  "      amount: +(attDays[date].size * dailyRate).toFixed(2),\n" +
  "    }));\n" +
  "\n" +
  "    // Teltik: one block per rotation. Block = [valid_from, min(next rotation,\n" +
  "    // valid_from + rotation_interval_hours)). Bills into the cycle containing\n" +
  "    // valid_from's EST date. Billable iff any SMS on any EST date the block touches.\n" +
  "    const teltikBlocks = {};\n" +
  "    if (teltikSimIds.length > 0) {\n" +
  "      const wideStart = new Date(start + 'T00:00:00Z');\n" +
  "      wideStart.setUTCDate(wideStart.getUTCDate() - 2);\n" +
  "      const wideEnd = new Date(end + 'T00:00:00Z');\n" +
  "      wideEnd.setUTCDate(wideEnd.getUTCDate() + 3);\n" +
  "      const idList = teltikSimIds.join(',');\n" +
  "      const rotResp = await supabaseGet(env,\n" +
  "        'sim_numbers?select=sim_id,valid_from&sim_id=in.(' + idList + ')' +\n" +
  "        '&valid_from=gte.' + encodeURIComponent(wideStart.toISOString()) +\n" +
  "        '&valid_from=lt.' + encodeURIComponent(wideEnd.toISOString()) +\n" +
  "        '&order=sim_id.asc,valid_from.asc' +\n" +
  "        '&limit=50000'\n" +
  "      );\n" +
  "      const rotations = await rotResp.json();\n" +
  "      if (Array.isArray(rotations)) {\n" +
  "        const byThen = new Map();\n" +
  "        for (const r of rotations) {\n" +
  "          if (!byThen.has(r.sim_id)) byThen.set(r.sim_id, []);\n" +
  "          byThen.get(r.sim_id).push(new Date(r.valid_from));\n" +
  "        }\n" +
  "        for (const [simId, rots] of byThen) {\n" +
  "          const intervalMs = (teltikIntervalBySim.get(simId) || 48) * 3600 * 1000;\n" +
  "          for (let i = 0; i < rots.length; i++) {\n" +
  "            const rotStart = rots[i];\n" +
  "            const rotNext = rots[i + 1];\n" +
  "            const blockEnd = new Date(Math.min(\n" +
  "              rotStart.getTime() + intervalMs,\n" +
  "              rotNext ? rotNext.getTime() : Number.POSITIVE_INFINITY\n" +
  "            ));\n" +
  "            const startEst = estDateFromDate(rotStart);\n" +
  "            if (startEst < start || startEst > end) continue;\n" +
  "            const endEstInclusive = estDateFromDate(new Date(blockEnd.getTime() - 1000));\n" +
  "            const daysSet = teltikSmsDaysBySim.get(simId) || new Set();\n" +
  "            let hasSms = false;\n" +
  "            for (let cur = startEst; cur <= endEstInclusive; cur = nextEstDate(cur)) {\n" +
  "              if (daysSet.has(cur)) { hasSms = true; break; }\n" +
  "            }\n" +
  "            if (!hasSms) continue;\n" +
  "            if (!teltikBlocks[startEst]) teltikBlocks[startEst] = 0;\n" +
  "            teltikBlocks[startEst] += 1;\n" +
  "          }\n" +
  "        }\n" +
  "      }\n" +
  "    }\n" +
  "\n" +
  "    const teltikEntries = Object.keys(teltikBlocks).sort().map(date => ({\n" +
  "      date, sim_count: teltikBlocks[date], rate: blockRate,\n" +
  "      amount: +(teltikBlocks[date] * blockRate).toFixed(2),\n" +
  "    }));\n";

if (!content.includes(PREVIEW_OLD)) {
  console.error('PATCH FAILED: handleBillingPreview teltik section not found.');
  process.exit(1);
}
content = content.replace(PREVIEW_OLD, PREVIEW_NEW);

// ---------- 3. handleBillingDownloadInvoice teltik section (D-suffix vars) ----------
const DL_OLD =
  "      'reseller_sims?select=sim_id,sims(vendor,sim_sms_daily(est_date,sms_count))' +\n" +
  "      '&reseller_id=eq.' + encodeURIComponent(resellerId) +\n" +
  "      '&active=eq.true' +\n" +
  "      '&limit=5000'\n" +
  "    );\n" +
  "    const rsSims = await smsResp.json();\n" +
  "\n" +
  "    const attDaysD = {};\n" +
  "    const teltikDaysD = {};\n" +
  "    if (Array.isArray(rsSims)) {\n" +
  "      for (const rs of rsSims) {\n" +
  "        const daily = rs.sims?.sim_sms_daily;\n" +
  "        if (!Array.isArray(daily)) continue;\n" +
  "        const targetD = rs.sims?.vendor === 'teltik' ? teltikDaysD : attDaysD;\n" +
  "        for (const row of daily) {\n" +
  "          if (!row.est_date || row.sms_count <= 0) continue;\n" +
  "          if (row.est_date < start || row.est_date > end) continue;\n" +
  "          if (!targetD[row.est_date]) targetD[row.est_date] = new Set();\n" +
  "          targetD[row.est_date].add(rs.sim_id);\n" +
  "        }\n" +
  "      }\n" +
  "    }\n" +
  "\n" +
  "    const dailyRate = parseFloat(mapping.daily_rate);\n" +
  "    const blockRateD = +(dailyRate * 2).toFixed(2);\n" +
  "\n" +
  "    const attEntriesD = Object.keys(attDaysD).sort().map(date => ({\n" +
  "      date, sim_count: attDaysD[date].size, rate: dailyRate,\n" +
  "      amount: +(attDaysD[date].size * dailyRate).toFixed(2),\n" +
  "    }));\n" +
  "\n" +
  "    const teltikBlocksD = {};\n" +
  "    for (let bs = start; bs <= end; ) {\n" +
  "      const d0 = bs;\n" +
  "      const tmp = new Date(d0 + 'T00:00:00Z');\n" +
  "      tmp.setUTCDate(tmp.getUTCDate() + 1);\n" +
  "      const d1 = tmp.toISOString().slice(0, 10);\n" +
  "      const simsInBlock = new Set();\n" +
  "      for (const [date, sims] of Object.entries(teltikDaysD)) {\n" +
  "        if (date === d0 || date === d1) { for (const s of sims) simsInBlock.add(s); }\n" +
  "      }\n" +
  "      if (simsInBlock.size > 0) teltikBlocksD[d0] = simsInBlock;\n" +
  "      tmp.setUTCDate(tmp.getUTCDate() + 1);\n" +
  "      bs = tmp.toISOString().slice(0, 10);\n" +
  "    }\n" +
  "    const teltikEntriesD = Object.keys(teltikBlocksD).sort().map(date => ({\n" +
  "      date, sim_count: teltikBlocksD[date].size, rate: blockRateD,\n" +
  "      amount: +(teltikBlocksD[date].size * blockRateD).toFixed(2),\n" +
  "    }));\n";

const DL_NEW =
  "      'reseller_sims?select=sim_id,sims(vendor,rotation_interval_hours,sim_sms_daily(est_date,sms_count))' +\n" +
  "      '&reseller_id=eq.' + encodeURIComponent(resellerId) +\n" +
  "      '&active=eq.true' +\n" +
  "      '&limit=5000'\n" +
  "    );\n" +
  "    const rsSims = await smsResp.json();\n" +
  "\n" +
  "    const dailyRate = parseFloat(mapping.daily_rate);\n" +
  "    const blockRateD = +(dailyRate * 2).toFixed(2);\n" +
  "\n" +
  "    const attDaysD = {};\n" +
  "    const teltikSimIdsD = [];\n" +
  "    const teltikSmsDaysBySimD = new Map();\n" +
  "    const teltikIntervalBySimD = new Map();\n" +
  "    if (Array.isArray(rsSims)) {\n" +
  "      for (const rs of rsSims) {\n" +
  "        const daily = rs.sims?.sim_sms_daily;\n" +
  "        if (rs.sims?.vendor === 'teltik') {\n" +
  "          teltikSimIdsD.push(rs.sim_id);\n" +
  "          teltikIntervalBySimD.set(rs.sim_id, rs.sims?.rotation_interval_hours || 48);\n" +
  "          const days = new Set();\n" +
  "          if (Array.isArray(daily)) {\n" +
  "            for (const row of daily) {\n" +
  "              if (row.est_date && row.sms_count > 0) days.add(row.est_date);\n" +
  "            }\n" +
  "          }\n" +
  "          teltikSmsDaysBySimD.set(rs.sim_id, days);\n" +
  "          continue;\n" +
  "        }\n" +
  "        if (!Array.isArray(daily)) continue;\n" +
  "        for (const row of daily) {\n" +
  "          if (!row.est_date || row.sms_count <= 0) continue;\n" +
  "          if (row.est_date < start || row.est_date > end) continue;\n" +
  "          if (!attDaysD[row.est_date]) attDaysD[row.est_date] = new Set();\n" +
  "          attDaysD[row.est_date].add(rs.sim_id);\n" +
  "        }\n" +
  "      }\n" +
  "    }\n" +
  "\n" +
  "    const attEntriesD = Object.keys(attDaysD).sort().map(date => ({\n" +
  "      date, sim_count: attDaysD[date].size, rate: dailyRate,\n" +
  "      amount: +(attDaysD[date].size * dailyRate).toFixed(2),\n" +
  "    }));\n" +
  "\n" +
  "    const teltikBlocksD = {};\n" +
  "    if (teltikSimIdsD.length > 0) {\n" +
  "      const wideStart = new Date(start + 'T00:00:00Z');\n" +
  "      wideStart.setUTCDate(wideStart.getUTCDate() - 2);\n" +
  "      const wideEnd = new Date(end + 'T00:00:00Z');\n" +
  "      wideEnd.setUTCDate(wideEnd.getUTCDate() + 3);\n" +
  "      const idList = teltikSimIdsD.join(',');\n" +
  "      const rotResp = await supabaseGet(env,\n" +
  "        'sim_numbers?select=sim_id,valid_from&sim_id=in.(' + idList + ')' +\n" +
  "        '&valid_from=gte.' + encodeURIComponent(wideStart.toISOString()) +\n" +
  "        '&valid_from=lt.' + encodeURIComponent(wideEnd.toISOString()) +\n" +
  "        '&order=sim_id.asc,valid_from.asc' +\n" +
  "        '&limit=50000'\n" +
  "      );\n" +
  "      const rotations = await rotResp.json();\n" +
  "      if (Array.isArray(rotations)) {\n" +
  "        const byThen = new Map();\n" +
  "        for (const r of rotations) {\n" +
  "          if (!byThen.has(r.sim_id)) byThen.set(r.sim_id, []);\n" +
  "          byThen.get(r.sim_id).push(new Date(r.valid_from));\n" +
  "        }\n" +
  "        for (const [simId, rots] of byThen) {\n" +
  "          const intervalMs = (teltikIntervalBySimD.get(simId) || 48) * 3600 * 1000;\n" +
  "          for (let i = 0; i < rots.length; i++) {\n" +
  "            const rotStart = rots[i];\n" +
  "            const rotNext = rots[i + 1];\n" +
  "            const blockEnd = new Date(Math.min(\n" +
  "              rotStart.getTime() + intervalMs,\n" +
  "              rotNext ? rotNext.getTime() : Number.POSITIVE_INFINITY\n" +
  "            ));\n" +
  "            const startEst = estDateFromDate(rotStart);\n" +
  "            if (startEst < start || startEst > end) continue;\n" +
  "            const endEstInclusive = estDateFromDate(new Date(blockEnd.getTime() - 1000));\n" +
  "            const daysSet = teltikSmsDaysBySimD.get(simId) || new Set();\n" +
  "            let hasSms = false;\n" +
  "            for (let cur = startEst; cur <= endEstInclusive; cur = nextEstDate(cur)) {\n" +
  "              if (daysSet.has(cur)) { hasSms = true; break; }\n" +
  "            }\n" +
  "            if (!hasSms) continue;\n" +
  "            if (!teltikBlocksD[startEst]) teltikBlocksD[startEst] = 0;\n" +
  "            teltikBlocksD[startEst] += 1;\n" +
  "          }\n" +
  "        }\n" +
  "      }\n" +
  "    }\n" +
  "\n" +
  "    const teltikEntriesD = Object.keys(teltikBlocksD).sort().map(date => ({\n" +
  "      date, sim_count: teltikBlocksD[date], rate: blockRateD,\n" +
  "      amount: +(teltikBlocksD[date] * blockRateD).toFixed(2),\n" +
  "    }));\n";

if (!content.includes(DL_OLD)) {
  console.error('PATCH FAILED: handleBillingDownloadInvoice teltik section not found.');
  process.exit(1);
}
content = content.replace(DL_OLD, DL_NEW);

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch applied: Teltik rotation-aligned billing blocks installed in both handlers.');
