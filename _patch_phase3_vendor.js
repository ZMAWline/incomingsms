// Phase 3: Dashboard vendor support for ATOMIC + Wing IoT
// Changes:
// 1. Update vendor filter dropdown to include atomic and wing_iot
// 2. Change helix_api_logs to carrier_api_logs
// 3. Update vendor badge rendering for atomic and wing_iot
// 4. Update OTA button condition to exclude wing_iot
// 5. Update Retry button condition to exclude wing_iot

const fs = require('fs');
const path = require('path');

const dashPath = path.join(__dirname, 'src', 'dashboard', 'index.js');
let content = fs.readFileSync(dashPath, 'utf8');

const changes = [];

// 1. Update vendor filter dropdown - add atomic and wing_iot options
// Using simpler match since CRLF makes multi-line matching tricky
const vendorFilterOld = `<option value="helix">Helix</option>
                                    <option value="teltik">Teltik</option>
                                </select>
                                <select id="filter-special"`;

const vendorFilterNew = `<option value="helix">Helix (legacy)</option>
                                    <option value="atomic">ATOMIC</option>
                                    <option value="wing_iot">Wing IoT</option>
                                    <option value="teltik">Teltik</option>
                                </select>
                                <select id="filter-special"`;

if (content.includes(vendorFilterOld)) {
  content = content.replace(vendorFilterOld, vendorFilterNew);
  changes.push('1. Updated vendor filter dropdown with atomic + wing_iot options');
} else if (content.includes(vendorFilterOld.replace(/\n/g, '\r\n'))) {
  content = content.replace(vendorFilterOld.replace(/\n/g, '\r\n'), vendorFilterNew.replace(/\n/g, '\r\n'));
  changes.push('1. Updated vendor filter dropdown with atomic + wing_iot options');
} else {
  console.error('ERROR: Could not find vendor filter dropdown');
  process.exit(1);
}

// 2. Change helix_api_logs to carrier_api_logs
const helixLogsOld = "helix_api_logs?select=id,step,iccid,imei,request_url";
const carrierLogsNew = "carrier_api_logs?select=id,step,iccid,imei,vendor,request_url";

if (content.includes(helixLogsOld)) {
  content = content.replace(helixLogsOld, carrierLogsNew);
  changes.push('2. Changed helix_api_logs to carrier_api_logs (added vendor column)');
} else {
  console.error('ERROR: Could not find helix_api_logs query');
  process.exit(1);
}

// 3. Update vendor badge rendering - handle atomic and wing_iot
const vendorBadgeOld = `const vendorBadge = sim.vendor === 'teltik' ? '<span class="px-1.5 py-0.5 text-xs font-medium rounded bg-purple-500/20 text-purple-300">Teltik</span>' : '<span class="px-1.5 py-0.5 text-xs font-medium rounded bg-gray-500/20 text-gray-400">Helix</span>';`;

const vendorBadgeNew = `const vendorBadge = { teltik: '<span class="px-1.5 py-0.5 text-xs font-medium rounded bg-purple-500/20 text-purple-300">Teltik</span>', atomic: '<span class="px-1.5 py-0.5 text-xs font-medium rounded bg-blue-500/20 text-blue-300">ATOMIC</span>', wing_iot: '<span class="px-1.5 py-0.5 text-xs font-medium rounded bg-green-500/20 text-green-300">Wing IoT</span>', helix: '<span class="px-1.5 py-0.5 text-xs font-medium rounded bg-gray-500/20 text-gray-400">Helix</span>' }[sim.vendor] || '<span class="px-1.5 py-0.5 text-xs font-medium rounded bg-gray-500/20 text-gray-400">-</span>';`;

if (content.includes(vendorBadgeOld)) {
  content = content.replace(vendorBadgeOld, vendorBadgeNew);
  changes.push('3. Updated vendor badge to handle atomic and wing_iot');
} else {
  console.error('ERROR: Could not find vendor badge code');
  process.exit(1);
}

// 4. Update OTA button condition - exclude wing_iot (AT&T IoT doesn't support OTA)
const otaButtonOld = `(sim.vendor !== 'teltik' && sim.status === 'active')`;
const otaButtonNew = `(!['teltik', 'wing_iot'].includes(sim.vendor) && sim.status === 'active')`;

if (content.includes(otaButtonOld)) {
  content = content.replace(otaButtonOld, otaButtonNew);
  changes.push('4. Updated OTA button to exclude wing_iot');
} else {
  console.error('ERROR: Could not find OTA button code');
  process.exit(1);
}

// 5. Update Retry button condition - exclude wing_iot
const retryButtonOld = `(sim.vendor !== 'teltik' && sim.status === 'error')`;
const retryButtonNew = `(!['teltik', 'wing_iot'].includes(sim.vendor) && sim.status === 'error')`;

if (content.includes(retryButtonOld)) {
  content = content.replace(retryButtonOld, retryButtonNew);
  changes.push('5. Updated Retry button to exclude wing_iot');
} else {
  console.error('ERROR: Could not find Retry button code');
  process.exit(1);
}

// Write the file
fs.writeFileSync(dashPath, content, 'utf8');

console.log('Phase 3 dashboard patch applied successfully!');
console.log('Changes:');
changes.forEach(c => console.log('  ' + c));
console.log('\nRun syntax check: node --input-type=module --check < src/dashboard/index.js');
