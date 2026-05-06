// Patch C2: Fix 4 provider-leak bugs in dashboard.
// 1. Line 428: sim.vendor || 'helix' → sim.vendor || 'unknown'
// 2. Line 2865: logData.vendor || 'helix' → logData.vendor || 'unknown'
// 3. Lines 3237/3390: rename helixDays/helixDaysD → attDays/attDaysD + update comments
// 4. Line 8792 (frontend): sim.vendor || 'helix' → sim.vendor || 'unknown'
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');
const before = content;

// Fix 1: handleSims row mapping default vendor
const OLD1 = "vendor: sim.vendor || 'helix',";
const NEW1 = "vendor: sim.vendor || 'unknown',";
if (!content.includes(OLD1)) { console.error('PATCH FAILED: fix 1 not found'); process.exit(1); }
content = content.replace(OLD1, NEW1);

// Fix 2: logCarrierApiCall default vendor
const OLD2 = "const vendor = logData.vendor || 'helix';";
const NEW2 = "const vendor = logData.vendor || 'unknown';";
if (!content.includes(OLD2)) { console.error('PATCH FAILED: fix 2 not found'); process.exit(1); }
content = content.replace(OLD2, NEW2);

// Fix 3a: rename helixDays → attDays in billing preview
const OLD3A = "    const helixDays = {}; // est_date → Set of sim_ids\n" +
              "    const teltikDays = {}; // est_date → Set of sim_ids";
const NEW3A = "    const attDays = {}; // est_date → Set of sim_ids (AT&T: helix + atomic + wing_iot)\n" +
              "    const teltikDays = {}; // est_date → Set of sim_ids (T-Mobile: teltik)";
if (!content.includes(OLD3A)) { console.error('PATCH FAILED: fix 3a not found'); process.exit(1); }
content = content.replace(OLD3A, NEW3A);

// Fix 3b: routing logic
const OLD3B = "        const target = rs.sims?.vendor === 'teltik' ? teltikDays : helixDays;";
const NEW3B = "        const target = rs.sims?.vendor === 'teltik' ? teltikDays : attDays;";
if (!content.includes(OLD3B)) { console.error('PATCH FAILED: fix 3b not found'); process.exit(1); }
content = content.replace(OLD3B, NEW3B);

// Fix 3c: helixEntries → attEntries
const OLD3C = "    // Helix: bill per calendar day at dailyRate\n" +
              "    const helixEntries = Object.keys(helixDays).sort().map(date => ({\n" +
              "      date, sim_count: helixDays[date].size, rate: dailyRate,\n" +
              "      amount: +(helixDays[date].size * dailyRate).toFixed(2),\n" +
              "    }));";
const NEW3C = "    // AT&T (helix/atomic/wing): bill per calendar day at dailyRate\n" +
              "    const attEntries = Object.keys(attDays).sort().map(date => ({\n" +
              "      date, sim_count: attDays[date].size, rate: dailyRate,\n" +
              "      amount: +(attDays[date].size * dailyRate).toFixed(2),\n" +
              "    }));";
if (!content.includes(OLD3C)) { console.error('PATCH FAILED: fix 3c not found'); process.exit(1); }
content = content.replace(OLD3C, NEW3C);

// Fix 3d: update references to helixEntries in the rest of the function
// Search for all remaining helixEntries references
content = content.replace(/helixEntries/g, 'attEntries');

// Fix 3e: rename helixDaysD → attDaysD in the duplicate-day billing
const OLD3E = "    const helixDaysD = {};\n    const teltikDaysD = {};";
const NEW3E = "    const attDaysD = {};\n    const teltikDaysD = {};";
if (!content.includes(OLD3E)) { console.error('PATCH FAILED: fix 3e not found'); process.exit(1); }
content = content.replace(OLD3E, NEW3E);

// Fix 3f: routing in duplicate section
const OLD3F = "        const targetD = rs.sims?.vendor === 'teltik' ? teltikDaysD : helixDaysD;";
const NEW3F = "        const targetD = rs.sims?.vendor === 'teltik' ? teltikDaysD : attDaysD;";
if (!content.includes(OLD3F)) { console.error('PATCH FAILED: fix 3f not found'); process.exit(1); }
content = content.replace(OLD3F, NEW3F);

// Fix remaining helixDaysD references
content = content.replace(/helixDaysD/g, 'attDaysD');

// Fix 4: frontend querySimCarrier default vendor (inside template literal)
const OLD4 = "querySimCarrier(simId, sim.vendor || 'helix',";
const NEW4 = "querySimCarrier(simId, sim.vendor || 'unknown',";
if (!content.includes(OLD4)) { console.error('PATCH FAILED: fix 4 not found'); process.exit(1); }
content = content.replace(OLD4, NEW4);

if (content === before) { console.error('ERROR: no replacements made'); process.exit(1); }

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch C2 applied: 4 provider-leak bugs fixed');
console.log('  1. sim.vendor default: helix → unknown');
console.log('  2. logCarrierApiCall vendor default: helix → unknown');
console.log('  3. Billing buckets renamed: helixDays → attDays (clarity, no logic change)');
console.log('  4. Frontend querySimCarrier vendor default: helix → unknown');
