// Rename Helix Query to Carrier Query and add Wing IoT support
const fs = require('fs');
const path = require('path');

const dashPath = path.join(__dirname, 'src', 'dashboard', 'index.js');
let content = fs.readFileSync(dashPath, 'utf8');

const changes = [];

// 1. Update modal title and add vendor selector
const modalHeaderOld = `<h3 class="text-lg font-semibold text-white">Query Helix Subscriber</h3>
                <button onclick="hideHelixQueryModal()" class="text-gray-400 hover:text-white text-xl leading-none">&times;</button>
            </div>
            <div class="p-5">
                <p class="text-sm text-gray-400 mb-3">Enter a Mobility Subscription ID:</p>
                <input type="text" id="helix-subid-input"`;

const modalHeaderNew = `<h3 class="text-lg font-semibold text-white">Carrier Query</h3>
                <button onclick="hideHelixQueryModal()" class="text-gray-400 hover:text-white text-xl leading-none">&times;</button>
            </div>
            <div class="p-5">
                <div class="flex items-center gap-3 mb-3">
                    <label class="text-sm text-gray-400">Vendor:</label>
                    <select id="carrier-query-vendor" onchange="updateCarrierQueryUI()" class="text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300 focus:outline-none focus:border-accent">
                        <option value="helix">Helix / ATOMIC (Sub ID)</option>
                        <option value="wing_iot">Wing IoT (ICCID)</option>
                    </select>
                </div>
                <p id="carrier-query-label" class="text-sm text-gray-400 mb-3">Enter a Mobility Subscription ID:</p>
                <input type="text" id="helix-subid-input"`;

if (content.includes(modalHeaderOld)) {
  content = content.replace(modalHeaderOld, modalHeaderNew);
  changes.push('1. Updated modal header with vendor selector');
} else if (content.includes(modalHeaderOld.replace(/\n/g, '\r\n'))) {
  content = content.replace(modalHeaderOld.replace(/\n/g, '\r\n'), modalHeaderNew.replace(/\n/g, '\r\n'));
  changes.push('1. Updated modal header with vendor selector');
} else {
  console.error('ERROR: Could not find modal header');
  process.exit(1);
}

// 2. Update placeholder
const placeholderOld = `placeholder="e.g. 40033"/>`;
const placeholderNew = `placeholder="e.g. 40033 or ICCID"/>`;

if (content.includes(placeholderOld)) {
  content = content.replace(placeholderOld, placeholderNew);
  changes.push('2. Updated input placeholder');
}

// 3. Add updateCarrierQueryUI and update queryHelix function (find queryHelixSubId and add before it)
const querySubIdOld = `function queryHelixSubId(subId) {`;

const querySubIdNew = `function updateCarrierQueryUI() {
            const vendor = document.getElementById('carrier-query-vendor').value;
            const label = document.getElementById('carrier-query-label');
            const input = document.getElementById('helix-subid-input');
            const bulkBtn = document.getElementById('helix-bulk-btn');
            if (vendor === 'wing_iot') {
                label.textContent = 'Enter ICCID:';
                input.placeholder = 'e.g. 89010303300133220351';
                bulkBtn.style.display = 'none';
            } else {
                label.textContent = 'Enter a Mobility Subscription ID:';
                input.placeholder = 'e.g. 40033';
                bulkBtn.style.display = '';
            }
        }

        function queryHelixSubId(subId) {`;

if (content.includes(querySubIdOld)) {
  content = content.replace(querySubIdOld, querySubIdNew);
  changes.push('3. Added updateCarrierQueryUI function');
} else if (content.includes(querySubIdOld.replace(/\n/g, '\r\n'))) {
  content = content.replace(querySubIdOld.replace(/\n/g, '\r\n'), querySubIdNew.replace(/\n/g, '\r\n'));
  changes.push('3. Added updateCarrierQueryUI function');
} else {
  console.error('ERROR: Could not find queryHelixSubId');
  process.exit(1);
}

// 4. Update queryHelix function to handle Wing IoT
const queryHelixOld = `async function queryHelix() {
            const subId = document.getElementById('helix-subid-input').value.trim();
            if (!subId) {
                showToast('Please enter a Subscription ID', 'error');
                return;
            }

            const btn = document.getElementById('helix-query-btn');
            btn.disabled = true;
            btn.textContent = 'Querying...';
            document.getElementById('helix-bulk-result').classList.add('hidden');

            try {
                const response = await fetch(\\\`\\\${API_BASE}/helix-query\\\`,`;

const queryHelixNew = `async function queryHelix() {
            const vendor = document.getElementById('carrier-query-vendor').value;
            const inputVal = document.getElementById('helix-subid-input').value.trim();
            if (!inputVal) {
                showToast(vendor === 'wing_iot' ? 'Please enter an ICCID' : 'Please enter a Subscription ID', 'error');
                return;
            }

            const btn = document.getElementById('helix-query-btn');
            btn.disabled = true;
            btn.textContent = 'Querying...';
            document.getElementById('helix-bulk-result').classList.add('hidden');

            // Wing IoT query
            if (vendor === 'wing_iot') {
                try {
                    const response = await fetch(\\\`\\\${API_BASE}/wing-check\\\`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ iccid: inputVal })
                    });
                    const result = await response.json();
                    const outputEl = document.getElementById('helix-query-output');
                    const resultDiv = document.getElementById('helix-query-result');
                    document.getElementById('helix-db-update-banner').classList.add('hidden');

                    if (result.ok) {
                        const data = result.response;
                        let formatted = '<span class="text-green-400 font-bold">Wing IoT Device Found</span>\\n\\n';
                        formatted += '<span class="text-blue-400">status:</span> ' + (data.status || 'N/A') + '\\n';
                        formatted += '<span class="text-blue-400">mdn:</span> ' + (data.mdn || 'N/A') + '\\n';
                        formatted += '<span class="text-blue-400">communicationPlan:</span> ' + (data.communicationPlan || 'N/A') + '\\n';
                        formatted += '<span class="text-blue-400">customer:</span> ' + (data.customer || '(blank)') + '\\n';
                        formatted += '\\n<span class="text-gray-500">--- Full Response ---</span>\\n';
                        formatted += JSON.stringify(data, null, 2);
                        outputEl.innerHTML = formatted;
                    } else {
                        outputEl.innerHTML = '<span class="text-red-400">Wing IoT Error (HTTP ' + result.status + '):</span>\\n' + JSON.stringify(result.response, null, 2);
                    }
                    resultDiv.classList.remove('hidden');
                } catch (error) {
                    showToast('Error querying Wing IoT', 'error');
                    console.error(error);
                } finally {
                    btn.disabled = false;
                    btn.textContent = 'Query';
                }
                return;
            }

            // Helix query (original)
            try {
                const response = await fetch(\\\`\\\${API_BASE}/helix-query\\\`,`;

if (content.includes(queryHelixOld)) {
  content = content.replace(queryHelixOld, queryHelixNew);
  changes.push('4. Updated queryHelix to handle Wing IoT');
} else if (content.includes(queryHelixOld.replace(/\n/g, '\r\n'))) {
  content = content.replace(queryHelixOld.replace(/\n/g, '\r\n'), queryHelixNew.replace(/\n/g, '\r\n'));
  changes.push('4. Updated queryHelix to handle Wing IoT');
} else {
  console.error('ERROR: Could not find queryHelix function');
  process.exit(1);
}

// 5. Fix the Helix query body to use inputVal instead of subId
const bodyOld = `body: JSON.stringify({ mobility_subscription_id: subId })`;
const bodyNew = `body: JSON.stringify({ mobility_subscription_id: inputVal })`;

if (content.includes(bodyOld)) {
  content = content.replace(bodyOld, bodyNew);
  changes.push('5. Fixed Helix query to use inputVal');
}

fs.writeFileSync(dashPath, content, 'utf8');

console.log('Carrier Query patch applied!');
changes.forEach(c => console.log('  ' + c));
