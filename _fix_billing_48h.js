import { readFileSync, writeFileSync } from 'fs';

const file = 'src/dashboard/index.js';
let src = readFileSync(file, 'utf8');
const hasCRLF = src.includes('\r\n');
let c = hasCRLF ? src.replace(/\r\n/g, '\n') : src;
const orig = c;

// ── 1. handleBillingPreview: daily → 48h block aggregation ──────────────────
c = c.replace(
`    // Aggregate: for each EST calendar day in range, count distinct SIMs with sms_count > 0
    const dailyCounts = {}; // est_date → Set of sim_ids
    if (Array.isArray(rsSims)) {
      for (const rs of rsSims) {
        const daily = rs.sims?.sim_sms_daily;
        if (!Array.isArray(daily)) continue;
        for (const row of daily) {
          if (!row.est_date || row.sms_count <= 0) continue;
          if (row.est_date < start || row.est_date > end) continue;
          if (!dailyCounts[row.est_date]) dailyCounts[row.est_date] = new Set();
          dailyCounts[row.est_date].add(rs.sim_id);
        }
      }
    }

    const dailyRate = mapping ? parseFloat(mapping.daily_rate) : 0;
    const days = Object.keys(dailyCounts).sort().map(date => ({
      date,
      sim_count: dailyCounts[date].size,
      amount: dailyCounts[date].size * dailyRate,
    }));
    const totalSimDays = days.reduce((s, d) => s + d.sim_count, 0);
    const totalAmount = totalSimDays * dailyRate;

    return new Response(JSON.stringify({
      reseller_id: resellerId,
      reseller_name: reseller?.name || resellerId,
      mapping,
      daily_rate: dailyRate,
      days,
      total_sim_days: totalSimDays,
      total_amount: totalAmount,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });`,
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
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });`
);

// ── 2. handleBillingDownloadInvoice: daily → 48h block aggregation ───────────
c = c.replace(
`    const dailyCounts = {};
    if (Array.isArray(rsSims)) {
      for (const rs of rsSims) {
        const daily = rs.sims?.sim_sms_daily;
        if (!Array.isArray(daily)) continue;
        for (const row of daily) {
          if (!row.est_date || row.sms_count <= 0) continue;
          if (row.est_date < start || row.est_date > end) continue;
          if (!dailyCounts[row.est_date]) dailyCounts[row.est_date] = new Set();
          dailyCounts[row.est_date].add(rs.sim_id);
        }
      }
    }

    const dailyRate = parseFloat(mapping.daily_rate);
    const days = Object.keys(dailyCounts).sort().map(date => ({
      date,
      sim_count: dailyCounts[date].size,
      amount: dailyCounts[date].size * dailyRate,
    }));
    const totalSimDays = days.reduce((s, d) => s + d.sim_count, 0);
    const totalAmount = +(totalSimDays * dailyRate).toFixed(2);`,
`    const activeDaysD = {};
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
    const totalAmount = +(totalSimDays * blockRateD).toFixed(2);`
);

// ── 3. Pass blockRateD (not dailyRate) to buildCSV ───────────────────────────
c = c.replace(
`    const csv = buildCSV(mapping.qbo_display_name, start, end, days, dailyRate);
    const filename = 'invoice_' + mapping.qbo_display_name`,
`    const csv = buildCSV(mapping.qbo_display_name, start, end, days, blockRateD);
    const filename = 'invoice_' + mapping.qbo_display_name`
);

// ── 4. Frontend preview: "Daily Rate" → "48hr Rate", use block_rate ──────────
// Use function replacement to avoid $' being interpreted as a special pattern
c = c.replace(
  `Daily Rate: <span class="text-accent">$' + Number(data.daily_rate).toFixed(2) + '</span>`,
  () => `48hr Rate: <span class="text-accent">$' + Number(data.block_rate || data.daily_rate * 2).toFixed(2) + '</span>`
);

// ── 5. Frontend preview total row: "SIM-days" → "SIM-blocks" ─────────────────
c = c.replace(
  '${data.total_sim_days} SIM-days',
  () => '${data.total_sim_blocks || data.total_sim_days} SIM-blocks'
);

// ── Verify all 5 replacements applied ────────────────────────────────────────
const checks = [
  ['blockRate', 'preview blockRate'],
  ['blockRateD', 'download blockRateD'],
  ['buildCSV(mapping.qbo_display_name, start, end, days, blockRateD)', 'buildCSV uses blockRateD'],
  ['48hr Rate', 'frontend 48hr label'],
  ['SIM-blocks', 'frontend SIM-blocks'],
];
let ok = true;
for (const [needle, label] of checks) {
  if (!c.includes(needle)) { console.error('MISSING:', label); ok = false; }
}
if (c === orig) { console.error('NO CHANGES MADE'); process.exit(1); }
if (!ok) process.exit(1);

writeFileSync(file, hasCRLF ? c.replace(/\n/g, '\r\n') : c);
console.log('Done — all 5 replacements applied');
