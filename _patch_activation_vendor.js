// Add vendor selection to dashboard activation modal
// Changes:
// 1. Add vendor dropdown to activate modal
// 2. Update activateSims function to handle vendor and optional IMEI for wing_iot
// 3. Update confirmation message

const fs = require('fs');
const path = require('path');

const dashPath = path.join(__dirname, 'src', 'dashboard', 'index.js');
let content = fs.readFileSync(dashPath, 'utf8');

const changes = [];

// 1. Add vendor dropdown to activate modal (before the textarea)
const activateModalOld = `<p class="text-sm text-gray-400 mb-3">Paste from spreadsheet or enter one SIM per line:</p>
                <textarea id="activate-input"`;

const activateModalNew = `<div class="flex items-center gap-3 mb-4">
                    <label class="text-sm text-gray-400">Vendor:</label>
                    <select id="activate-vendor" class="text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300 focus:outline-none focus:border-accent">
                        <option value="atomic" selected>ATOMIC (AT&T)</option>
                        <option value="wing_iot">Wing IoT (AT&T IoT)</option>
                        <option value="helix">Helix (legacy AT&T)</option>
                    </select>
                </div>
                <p class="text-sm text-gray-400 mb-3">Paste from spreadsheet or enter one SIM per line:</p>
                <textarea id="activate-input"`;

if (content.includes(activateModalOld)) {
  content = content.replace(activateModalOld, activateModalNew);
  changes.push('1. Added vendor dropdown to activate modal');
} else if (content.includes(activateModalOld.replace(/\n/g, '\r\n'))) {
  content = content.replace(activateModalOld.replace(/\n/g, '\r\n'), activateModalNew.replace(/\n/g, '\r\n'));
  changes.push('1. Added vendor dropdown to activate modal');
} else {
  console.error('ERROR: Could not find activate modal text');
  process.exit(1);
}

// 2. Update column instruction to note IMEI is optional for wing_iot
const columnInstructionOld = `<p class="text-xs text-gray-500 mt-2">3 columns: ICCID (20 digits), IMEI (15 digits), Reseller ID — tab or comma separated</p>`;

const columnInstructionNew = `<p class="text-xs text-gray-500 mt-2">3 columns: ICCID (20 digits), IMEI (15 digits or blank for Wing IoT), Reseller ID — tab or comma separated</p>`;

if (content.includes(columnInstructionOld)) {
  content = content.replace(columnInstructionOld, columnInstructionNew);
  changes.push('2. Updated column instruction (IMEI optional for Wing IoT)');
} else {
  console.error('ERROR: Could not find column instruction');
  process.exit(1);
}

// 3. Update IMEI validation to allow blank for wing_iot
const imeiValidationOld = `if (imei.length !== 15) {
                    errors.push(\\\`Line \\\${i + 1}: Invalid IMEI length (must be 15 digits)\\\`);
                    continue;
                }`;

const imeiValidationNew = `const vendor = document.getElementById('activate-vendor').value;
                if (vendor !== 'wing_iot' && imei.length !== 15) {
                    errors.push(\\\`Line \\\${i + 1}: Invalid IMEI length (must be 15 digits)\\\`);
                    continue;
                }`;

if (content.includes(imeiValidationOld)) {
  content = content.replace(imeiValidationOld, imeiValidationNew);
  changes.push('3. Updated IMEI validation (optional for wing_iot)');
} else if (content.includes(imeiValidationOld.replace(/\n/g, '\r\n'))) {
  content = content.replace(imeiValidationOld.replace(/\n/g, '\r\n'), imeiValidationNew.replace(/\n/g, '\r\n'));
  changes.push('3. Updated IMEI validation (optional for wing_iot)');
} else {
  console.error('ERROR: Could not find IMEI validation');
  process.exit(1);
}

// 4. Update confirmation message
const confirmOld = `if (!(await showConfirm('Activate SIMs', \\\`Are you sure you want to activate \\\${sims.length} SIM(s)? This will call the Helix API.\\\`))) {`;

const confirmNew = `const vendorLabel = { atomic: 'ATOMIC', wing_iot: 'Wing IoT', helix: 'Helix' }[document.getElementById('activate-vendor').value] || 'carrier';
            if (!(await showConfirm('Activate SIMs', \\\`Are you sure you want to activate \\\${sims.length} SIM(s) via \\\${vendorLabel}?\\\`))) {`;

if (content.includes(confirmOld)) {
  content = content.replace(confirmOld, confirmNew);
  changes.push('4. Updated confirmation message with vendor name');
} else if (content.includes(confirmOld.replace(/\n/g, '\r\n'))) {
  content = content.replace(confirmOld.replace(/\n/g, '\r\n'), confirmNew.replace(/\n/g, '\r\n'));
  changes.push('4. Updated confirmation message with vendor name');
} else {
  console.error('ERROR: Could not find confirmation dialog');
  process.exit(1);
}

// 5. Update API call to include vendor
const apiCallOld = `body: JSON.stringify({ sims })`;
const apiCallNew = `body: JSON.stringify({ sims, vendor: document.getElementById('activate-vendor').value })`;

if (content.includes(apiCallOld)) {
  content = content.replace(apiCallOld, apiCallNew);
  changes.push('5. Updated API call to include vendor');
} else {
  console.error('ERROR: Could not find API call');
  process.exit(1);
}

// Write the file
fs.writeFileSync(dashPath, content, 'utf8');

console.log('Activation vendor patch applied successfully!');
console.log('Changes:');
changes.forEach(c => console.log('  ' + c));
console.log('\nRun syntax check: node --input-type=module --check < src/dashboard/index.js');
