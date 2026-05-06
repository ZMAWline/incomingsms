// _fix_dashboard_pie_charts.js
// Adds two donut charts (SIMs by Status, SIMs by Vendor) to the main dashboard page.
// 1. Extends handleStats backend to return 7 new count fields.
// 2. Inserts chart canvas HTML below the stat cards.
// 3. Adds renderDashboardCharts() JS and calls it from loadData().
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

// ── PART 1: Extend handleStats backend ────────────────────────────────────────

const OLD1 =
`    const [totalRes, activeRes, provRes, msgRes] = await Promise.all([
      fetch(base + 'sims?select=id&limit=1', { headers: authHeaders }),
      fetch(base + 'sims?select=id&status=eq.active&limit=1', { headers: authHeaders }),
      fetch(base + 'sims?select=id&status=eq.provisioning&limit=1', { headers: authHeaders }),
      fetch(base + 'inbound_sms?select=id&received_at=gte.' + yesterday + '&limit=1', { headers: authHeaders }),
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
    };`;

const NEW1 =
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

if (!content.includes(OLD1)) { console.error('PATCH FAILED: Part 1 old string not found.'); process.exit(1); }
content = content.replace(OLD1, NEW1);
console.log('Part 1 applied.');

// ── PART 2: Insert chart HTML after stat cards grid ───────────────────────────

const OLD2 =
`                <!-- Quick Actions -->
                <div class="bg-dark-800 rounded-xl border border-dark-600 mb-6">
                    <div class="px-5 py-4 border-b border-dark-600">
                        <h2 class="text-lg font-semibold text-white">Quick Actions</h2>
                    </div>`;

const NEW2 =
`                <!-- SIM Charts -->
                <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                    <div class="bg-dark-800 rounded-xl p-5 border border-dark-600">
                        <h3 class="text-sm font-medium text-gray-400 mb-4">SIMs by Status</h3>
                        <canvas id="dash-status-chart" height="220"></canvas>
                    </div>
                    <div class="bg-dark-800 rounded-xl p-5 border border-dark-600">
                        <h3 class="text-sm font-medium text-gray-400 mb-4">SIMs by Vendor</h3>
                        <canvas id="dash-vendor-chart" height="220"></canvas>
                    </div>
                </div>

                <!-- Quick Actions -->
                <div class="bg-dark-800 rounded-xl border border-dark-600 mb-6">
                    <div class="px-5 py-4 border-b border-dark-600">
                        <h2 class="text-lg font-semibold text-white">Quick Actions</h2>
                    </div>`;

if (!content.includes(OLD2)) { console.error('PATCH FAILED: Part 2 old string not found.'); process.exit(1); }
content = content.replace(OLD2, NEW2);
console.log('Part 2 applied.');

// ── PART 3: Add renderDashboardCharts() and wire it into loadData() ──────────

// 3a: Call it in loadData after updateActiveRing
const OLD3A =
`                updateActiveRing(data.active_sims || 0, data.total_sims || 0);
                document.getElementById('last-updated').textContent = 'Updated ' + new Date().toLocaleTimeString();`;

const NEW3A =
`                updateActiveRing(data.active_sims || 0, data.total_sims || 0);
                renderDashboardCharts(data);
                document.getElementById('last-updated').textContent = 'Updated ' + new Date().toLocaleTimeString();`;

if (!content.includes(OLD3A)) { console.error('PATCH FAILED: Part 3a old string not found.'); process.exit(1); }
content = content.replace(OLD3A, NEW3A);
console.log('Part 3a applied.');

// 3b: Insert renderDashboardCharts function right before loadData()
const OLD3B = `        async function loadData() {`;

const NEW3B =
`        function renderDashboardCharts(data) {
            var donutOpts = {
                responsive: true,
                cutout: '65%',
                plugins: {
                    legend: { position: 'bottom', labels: { color: '#9ca3af', font: { size: 11 }, padding: 12 } }
                }
            };
            var statusCtx = document.getElementById('dash-status-chart');
            if (statusCtx) {
                if (window._dashStatusChart) window._dashStatusChart.destroy();
                window._dashStatusChart = new Chart(statusCtx, {
                    type: 'doughnut',
                    data: {
                        labels: ['Active', 'Provisioning', 'Suspended', 'Error', 'Canceled'],
                        datasets: [{
                            data: [
                                data.active_sims || 0, data.provisioning_sims || 0,
                                data.suspended_sims || 0, data.error_sims || 0, data.canceled_sims || 0
                            ],
                            backgroundColor: ['#22c55e', '#eab308', '#f97316', '#ef4444', '#991b1b'],
                            borderWidth: 0
                        }]
                    },
                    options: donutOpts
                });
            }
            var vendorCtx = document.getElementById('dash-vendor-chart');
            if (vendorCtx) {
                if (window._dashVendorChart) window._dashVendorChart.destroy();
                window._dashVendorChart = new Chart(vendorCtx, {
                    type: 'doughnut',
                    data: {
                        labels: ['ATOMIC', 'Teltik', 'Wing IoT', 'Helix'],
                        datasets: [{
                            data: [
                                data.vendor_atomic || 0, data.vendor_teltik || 0,
                                data.vendor_wing_iot || 0, data.vendor_helix || 0
                            ],
                            backgroundColor: ['#3b82f6', '#a855f7', '#22c55e', '#6b7280'],
                            borderWidth: 0
                        }]
                    },
                    options: donutOpts
                });
            }
        }

        async function loadData() {`;

if (!content.includes(OLD3B)) { console.error('PATCH FAILED: Part 3b old string not found.'); process.exit(1); }
content = content.replace(OLD3B, NEW3B);
console.log('Part 3b applied.');

// ── Write back ────────────────────────────────────────────────────────────────
content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('All patches applied successfully.');
