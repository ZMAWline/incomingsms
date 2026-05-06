import { readFileSync, writeFileSync } from 'fs';

const file = 'src/dashboard/index.js';
let src = readFileSync(file, 'utf8');
const hasCRLF = src.includes('\r\n');
let c = hasCRLF ? src.replace(/\r\n/g, '\n') : src;
const orig = c;

// ── 1. buildCSV: use per-row rate if present ─────────────────────────────────
c = c.replace(
  `      d.sim_count,\n      dailyRate.toFixed(2),\n      d.amount.toFixed(2),`,
  () => `      d.sim_count,\n      (d.rate !== undefined ? d.rate : dailyRate).toFixed(2),\n      d.amount.toFixed(2),`
);

// ── 2. Preview query: add vendor field ───────────────────────────────────────
c = c.replace(
  `// Get SIM-days with SMS for this reseller in the date range\n    // Join: reseller_sims → sims → sim_sms_daily\n    const smsResp = await supabaseGet(env,\n      'reseller_sims?select=sim_id,sims(sim_sms_daily(est_date,sms_count))' +`,
  () => `// Get SIM-days with SMS for this reseller in the date range\n    // Join: reseller_sims → sims → sim_sms_daily\n    const smsResp = await supabaseGet(env,\n      'reseller_sims?select=sim_id,sims(vendor,sim_sms_daily(est_date,sms_count))' +`
);

// ── 3. Preview aggregation: split by vendor, Helix=daily, Teltik=48h blocks ──
c = c.replace(
  `    // Collect active days (SIMs with SMS > 0 in range)
    const activeDays = {}; // est_date → Set of sim_ids
    if (Array.isArray(rsSims)) {
      for (const rs of rsSims) {
        const daily = rs.sims?.sim_sms_daily;
        if (!Array.isArray(daily)) continue;
        for (const row of daily) {
          if (!row.est_date || row.sms_count <= 0) continue;
          if (row.est_date < start || row.est_date > end) continue;
          if (!activeDays[row.est_date]) activeDays[row.est_date] = new Set();
          activeDays[row.est_date].add(rs.sim_id);
        }
      }
    }

    // Group into 48-hour billing blocks (pairs of calendar days starting from start)
    const dailyRate = mapping ? parseFloat(mapping.daily_rate) : 0;
    const blockRate = +(dailyRate * 2).toFixed(2);
    const blockCounts = {}; // blockStartDate → Set of sim_ids
    for (let bs = start; bs <= end; ) {
      const d0 = bs;
      const tmp = new Date(d0 + 'T00:00:00Z');
      tmp.setUTCDate(tmp.getUTCDate() + 1);
      const d1 = tmp.toISOString().slice(0, 10);
      const simsInBlock = new Set();
      for (const [date, sims] of Object.entries(activeDays)) {
        if (date === d0 || date === d1) { for (const s of sims) simsInBlock.add(s); }
      }
      if (simsInBlock.size > 0) blockCounts[d0] = simsInBlock;
      tmp.setUTCDate(tmp.getUTCDate() + 1);
      bs = tmp.toISOString().slice(0, 10);
    }

    const days = Object.keys(blockCounts).sort().map(date => ({
      date,
      sim_count: blockCounts[date].size,
      amount: +(blockCounts[date].size * blockRate).toFixed(2),
    }));
    const totalSimBlocks = days.reduce((s, d) => s + d.sim_count, 0);
    const totalAmount = +(totalSimBlocks * blockRate).toFixed(2);

    return new Response(JSON.stringify({
      reseller_id: resellerId,
      reseller_name: reseller?.name || resellerId,
      mapping,
      daily_rate: dailyRate,
      block_rate: blockRate,
      days,
      total_sim_days: totalSimBlocks,
      total_sim_blocks: totalSimBlocks,
      total_amount: totalAmount,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });`,
  () => `    // Collect active days by vendor (Helix=daily billing, Teltik=48h block billing)
    const dailyRate = mapping ? parseFloat(mapping.daily_rate) : 0;
    const blockRate = +(dailyRate * 2).toFixed(2);
    const helixDays = {}; // est_date → Set of sim_ids
    const teltikDays = {}; // est_date → Set of sim_ids
    if (Array.isArray(rsSims)) {
      for (const rs of rsSims) {
        const daily = rs.sims?.sim_sms_daily;
        if (!Array.isArray(daily)) continue;
        const target = rs.sims?.vendor === 'teltik' ? teltikDays : helixDays;
        for (const row of daily) {
          if (!row.est_date || row.sms_count <= 0) continue;
          if (row.est_date < start || row.est_date > end) continue;
          if (!target[row.est_date]) target[row.est_date] = new Set();
          target[row.est_date].add(rs.sim_id);
        }
      }
    }

    // Helix: bill per calendar day at dailyRate
    const helixEntries = Object.keys(helixDays).sort().map(date => ({
      date, sim_count: helixDays[date].size, rate: dailyRate,
      amount: +(helixDays[date].size * dailyRate).toFixed(2),
    }));

    // Teltik: bill per 48-hour block at blockRate
    const teltikBlocks = {};
    for (let bs = start; bs <= end; ) {
      const d0 = bs;
      const tmp = new Date(d0 + 'T00:00:00Z');
      tmp.setUTCDate(tmp.getUTCDate() + 1);
      const d1 = tmp.toISOString().slice(0, 10);
      const simsInBlock = new Set();
      for (const [date, sims] of Object.entries(teltikDays)) {
        if (date === d0 || date === d1) { for (const s of sims) simsInBlock.add(s); }
      }
      if (simsInBlock.size > 0) teltikBlocks[d0] = simsInBlock;
      tmp.setUTCDate(tmp.getUTCDate() + 1);
      bs = tmp.toISOString().slice(0, 10);
    }
    const teltikEntries = Object.keys(teltikBlocks).sort().map(date => ({
      date, sim_count: teltikBlocks[date].size, rate: blockRate,
      amount: +(teltikBlocks[date].size * blockRate).toFixed(2),
    }));

    const days = [...helixEntries, ...teltikEntries].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    const totalSimDays = days.reduce((s, d) => s + d.sim_count, 0);
    const totalAmount = +(days.reduce((s, d) => s + d.amount, 0)).toFixed(2);

    return new Response(JSON.stringify({
      reseller_id: resellerId,
      reseller_name: reseller?.name || resellerId,
      mapping,
      daily_rate: dailyRate,
      block_rate: blockRate,
      days,
      total_sim_days: totalSimDays,
      total_amount: totalAmount,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });`
);

// ── 4. Download query: add vendor field ──────────────────────────────────────
c = c.replace(
  `    const smsResp = await supabaseGet(env,\n      'reseller_sims?select=sim_id,sims(sim_sms_daily(est_date,sms_count))' +\n      '&reseller_id=eq.' + encodeURIComponent(resellerId) +\n      '&active=eq.true'\n    );\n    const rsSims = await smsResp.json();\n\n    const activeDaysD = {};`,
  () => `    const smsResp = await supabaseGet(env,\n      'reseller_sims?select=sim_id,sims(vendor,sim_sms_daily(est_date,sms_count))' +\n      '&reseller_id=eq.' + encodeURIComponent(resellerId) +\n      '&active=eq.true'\n    );\n    const rsSims = await smsResp.json();\n\n    const helixDaysD = {};`
);

// ── 5. Download aggregation: split by vendor ─────────────────────────────────
c = c.replace(
  `    const helixDaysD = {};
    if (Array.isArray(rsSims)) {
      for (const rs of rsSims) {
        const daily = rs.sims?.sim_sms_daily;
        if (!Array.isArray(daily)) continue;
        for (const row of daily) {
          if (!row.est_date || row.sms_count <= 0) continue;
          if (row.est_date < start || row.est_date > end) continue;
          if (!activeDaysD[row.est_date]) activeDaysD[row.est_date] = new Set();
          activeDaysD[row.est_date].add(rs.sim_id);
        }
      }
    }

    const dailyRate = parseFloat(mapping.daily_rate);
    const blockRateD = +(dailyRate * 2).toFixed(2);
    const blockCountsD = {};
    for (let bs = start; bs <= end; ) {
      const d0 = bs;
      const tmp = new Date(d0 + 'T00:00:00Z');
      tmp.setUTCDate(tmp.getUTCDate() + 1);
      const d1 = tmp.toISOString().slice(0, 10);
      const simsInBlock = new Set();
      for (const [date, sims] of Object.entries(activeDaysD)) {
        if (date === d0 || date === d1) { for (const s of sims) simsInBlock.add(s); }
      }
      if (simsInBlock.size > 0) blockCountsD[d0] = simsInBlock;
      tmp.setUTCDate(tmp.getUTCDate() + 1);
      bs = tmp.toISOString().slice(0, 10);
    }

    const days = Object.keys(blockCountsD).sort().map(date => ({
      date,
      sim_count: blockCountsD[date].size,
      amount: +(blockCountsD[date].size * blockRateD).toFixed(2),
    }));
    const totalSimDays = days.reduce((s, d) => s + d.sim_count, 0);
    const totalAmount = +(totalSimDays * blockRateD).toFixed(2);`,
  () => `    const teltikDaysD = {};
    if (Array.isArray(rsSims)) {
      for (const rs of rsSims) {
        const daily = rs.sims?.sim_sms_daily;
        if (!Array.isArray(daily)) continue;
        const targetD = rs.sims?.vendor === 'teltik' ? teltikDaysD : helixDaysD;
        for (const row of daily) {
          if (!row.est_date || row.sms_count <= 0) continue;
          if (row.est_date < start || row.est_date > end) continue;
          if (!targetD[row.est_date]) targetD[row.est_date] = new Set();
          targetD[row.est_date].add(rs.sim_id);
        }
      }
    }

    const dailyRate = parseFloat(mapping.daily_rate);
    const blockRateD = +(dailyRate * 2).toFixed(2);

    const helixEntriesD = Object.keys(helixDaysD).sort().map(date => ({
      date, sim_count: helixDaysD[date].size, rate: dailyRate,
      amount: +(helixDaysD[date].size * dailyRate).toFixed(2),
    }));

    const teltikBlocksD = {};
    for (let bs = start; bs <= end; ) {
      const d0 = bs;
      const tmp = new Date(d0 + 'T00:00:00Z');
      tmp.setUTCDate(tmp.getUTCDate() + 1);
      const d1 = tmp.toISOString().slice(0, 10);
      const simsInBlock = new Set();
      for (const [date, sims] of Object.entries(teltikDaysD)) {
        if (date === d0 || date === d1) { for (const s of sims) simsInBlock.add(s); }
      }
      if (simsInBlock.size > 0) teltikBlocksD[d0] = simsInBlock;
      tmp.setUTCDate(tmp.getUTCDate() + 1);
      bs = tmp.toISOString().slice(0, 10);
    }
    const teltikEntriesD = Object.keys(teltikBlocksD).sort().map(date => ({
      date, sim_count: teltikBlocksD[date].size, rate: blockRateD,
      amount: +(teltikBlocksD[date].size * blockRateD).toFixed(2),
    }));

    const days = [...helixEntriesD, ...teltikEntriesD].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    const totalSimDays = days.reduce((s, d) => s + d.sim_count, 0);
    const totalAmount = +(days.reduce((s, d) => s + d.amount, 0)).toFixed(2);`
);

// ── 6. Download buildCSV call: pass dailyRate (per-row rates now in d.rate) ──
c = c.replace(
  `    const csv = buildCSV(mapping.qbo_display_name, start, end, days, blockRateD);`,
  () => `    const csv = buildCSV(mapping.qbo_display_name, start, end, days, dailyRate);`
);

// ── 7. Frontend header: revert "48hr Rate" back to "Daily Rate" ──────────────
c = c.replace(
  `48hr Rate: <span class="text-accent">$' + Number(data.block_rate || data.daily_rate * 2).toFixed(2) + '</span>`,
  () => `Daily Rate: <span class="text-accent">$' + Number(data.daily_rate).toFixed(2) + '</span>`
);

// ── 8. Frontend total row: update label ──────────────────────────────────────
c = c.replace(
  '${data.total_sim_blocks || data.total_sim_days} SIM-blocks',
  () => '${data.total_sim_days} billable units'
);

// ── Verify all 8 replacements applied ────────────────────────────────────────
const checks = [
  ['d.rate !== undefined ? d.rate : dailyRate', 'buildCSV per-row rate'],
  ["sims(vendor,sim_sms_daily", 'vendor in preview query'],
  ['helixEntries', 'preview helix entries'],
  ['teltikEntries', 'preview teltik entries'],
  ["'reseller_sims?select=sim_id,sims(vendor,sim_sms_daily", 'vendor in download query'],
  ['helixEntriesD', 'download helix entries'],
  ['teltikEntriesD', 'download teltik entries'],
  ['buildCSV(mapping.qbo_display_name, start, end, days, dailyRate)', 'download buildCSV call'],
  ["Daily Rate: <span", 'frontend daily rate label'],
  ['billable units', 'frontend total label'],
];
let ok = true;
for (const [needle, label] of checks) {
  if (!c.includes(needle)) { console.error('MISSING:', label); ok = false; }
}
if (c === orig) { console.error('NO CHANGES MADE'); process.exit(1); }
if (!ok) process.exit(1);

writeFileSync(file, hasCRLF ? c.replace(/\n/g, '\r\n') : c);
console.log('Done — all replacements applied');
