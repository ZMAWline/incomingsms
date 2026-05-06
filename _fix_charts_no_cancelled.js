// _fix_charts_no_cancelled.js
// Remove cancelled SIMs from both dashboard charts:
// 1. Backend: drop canceled count query; vendor queries now exclude canceled SIMs.
// 2. Frontend status chart: remove Canceled segment.
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

// ── PART 1: Backend handleStats ───────────────────────────────────────────────

const OLD1 =
`    const [totalRes, activeRes, provRes, msgRes, suspRes, errRes, canRes, atmRes, telRes, wingRes, helRes] = await Promise.all([
      fetch(base + 'sims?select=id&limit=1', { headers: authHeaders }),
      fetch(base + 'sims?select=id&status=eq.active&limit=1', { headers: authHeaders }),
      fetch(base + 'sims?select=id&status=eq.provisioning&limit=1', { headers: authHeaders }),
      fetch(base + 'inbound_sms?select=id&received_at=gte.' + yesterday + '&limit=1', { headers: authHeaders }),
      fetch(base + 'sims?select=id&status=eq.suspended&limit=1', { headers: authHeaders }),
      fetch(base + 'sims?select=id&status=eq.error&limit=1', { headers: authHeaders }),
      fetch(base + 'sims?select=id&status=eq.canceled&limit=1', { headers: authHeaders }),
      fetch(base + 'sims?select=id&vendor=eq.atomic&limit=1', { headers: authHeaders }),
      fetch(base + 'sims?select=id&vendor=eq.teltik&limit=1', { headers: authHeaders }),
      fetch(base + 'sims?select=id&vendor=eq.wing_iot&limit=1', { headers: authHeaders }),
      fetch(base + 'sims?select=id&vendor=eq.helix&limit=1', { headers: authHeaders }),
    ]);

    const getCount = res => {
      const cr = res.headers.get('content-range') || '';
      return parseInt(cr.split('/')[1] || '0', 10);
    };

    const stats = {
      total_sims: getCount(totalRes),
      active_sims: getCount(activeRes),
      provisioning_sims: getCount(provRes),
      messages_24h: getCount(msgRes),
      suspended_sims: getCount(suspRes),
      error_sims: getCount(errRes),
      canceled_sims: getCount(canRes),
      vendor_atomic: getCount(atmRes),
      vendor_teltik: getCount(telRes),
      vendor_wing_iot: getCount(wingRes),
      vendor_helix: getCount(helRes),
    };`;

const NEW1 =
`    const [totalRes, activeRes, provRes, msgRes, suspRes, errRes, atmRes, telRes, wingRes, helRes] = await Promise.all([
      fetch(base + 'sims?select=id&limit=1', { headers: authHeaders }),
      fetch(base + 'sims?select=id&status=eq.active&limit=1', { headers: authHeaders }),
      fetch(base + 'sims?select=id&status=eq.provisioning&limit=1', { headers: authHeaders }),
      fetch(base + 'inbound_sms?select=id&received_at=gte.' + yesterday + '&limit=1', { headers: authHeaders }),
      fetch(base + 'sims?select=id&status=eq.suspended&limit=1', { headers: authHeaders }),
      fetch(base + 'sims?select=id&status=eq.error&limit=1', { headers: authHeaders }),
      fetch(base + 'sims?select=id&vendor=eq.atomic&status=neq.canceled&limit=1', { headers: authHeaders }),
      fetch(base + 'sims?select=id&vendor=eq.teltik&status=neq.canceled&limit=1', { headers: authHeaders }),
      fetch(base + 'sims?select=id&vendor=eq.wing_iot&status=neq.canceled&limit=1', { headers: authHeaders }),
      fetch(base + 'sims?select=id&vendor=eq.helix&status=neq.canceled&limit=1', { headers: authHeaders }),
    ]);

    const getCount = res => {
      const cr = res.headers.get('content-range') || '';
      return parseInt(cr.split('/')[1] || '0', 10);
    };

    const stats = {
      total_sims: getCount(totalRes),
      active_sims: getCount(activeRes),
      provisioning_sims: getCount(provRes),
      messages_24h: getCount(msgRes),
      suspended_sims: getCount(suspRes),
      error_sims: getCount(errRes),
      vendor_atomic: getCount(atmRes),
      vendor_teltik: getCount(telRes),
      vendor_wing_iot: getCount(wingRes),
      vendor_helix: getCount(helRes),
    };`;

if (!content.includes(OLD1)) { console.error('PATCH FAILED: Part 1 old string not found.'); process.exit(1); }
content = content.replace(OLD1, NEW1);
console.log('Part 1 applied.');

// ── PART 2: Frontend status chart — remove Canceled segment ──────────────────

const OLD2 =
`                        labels: ['Active', 'Provisioning', 'Suspended', 'Error', 'Canceled'],
                        datasets: [{
                            data: [
                                data.active_sims || 0, data.provisioning_sims || 0,
                                data.suspended_sims || 0, data.error_sims || 0, data.canceled_sims || 0
                            ],
                            backgroundColor: ['#22c55e', '#eab308', '#f97316', '#ef4444', '#991b1b'],`;

const NEW2 =
`                        labels: ['Active', 'Provisioning', 'Suspended', 'Error'],
                        datasets: [{
                            data: [
                                data.active_sims || 0, data.provisioning_sims || 0,
                                data.suspended_sims || 0, data.error_sims || 0
                            ],
                            backgroundColor: ['#22c55e', '#eab308', '#f97316', '#ef4444'],`;

if (!content.includes(OLD2)) { console.error('PATCH FAILED: Part 2 old string not found.'); process.exit(1); }
content = content.replace(OLD2, NEW2);
console.log('Part 2 applied.');

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('All patches applied successfully.');
