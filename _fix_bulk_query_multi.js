// _fix_bulk_query_multi.js
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');

// Normalize to LF
content = content.replace(/\r\n/g, '\n');

const OLD = `        function bulkQuery() {
            const selected = [...document.querySelectorAll('.sim-cb:checked')];
            if (selected.length === 0) { showToast('Select at least one SIM', 'error'); return; }
            if (selected.length > 1) { showToast('Query works on one SIM at a time. Select only one.', 'error'); return; }
            const simId = parseInt(selected[0].value);
            const sim = tableState.sims?.data?.find(s => s.id === simId);
            if (!sim) { showToast('SIM not found', 'error'); return; }
            querySimCarrier(simId, sim.vendor || 'unknown', sim.mobility_subscription_id || '', sim.iccid || '');
        }`;

const NEW = `        async function bulkQuery() {
            const selected = [...document.querySelectorAll('.sim-cb:checked')];
            if (selected.length === 0) { showToast('Select at least one SIM', 'error'); return; }

            // Single SIM: open the interactive query modal pre-filled
            if (selected.length === 1) {
                const simId = parseInt(selected[0].value);
                const sim = tableState.sims?.data?.find(s => s.id === simId);
                if (!sim) { showToast('SIM not found', 'error'); return; }
                querySimCarrier(simId, sim.vendor || 'unknown', sim.mobility_subscription_id || '', sim.iccid || '');
                return;
            }

            // Multiple SIMs: query each sequentially and show results in sim-action-modal
            const sims = selected.map(cb => tableState.sims?.data?.find(s => s.id === parseInt(cb.value))).filter(Boolean);

            const output = document.getElementById('sim-action-output');
            document.getElementById('sim-action-title').textContent = 'Bulk Query \u2014 ' + sims.length + ' SIMs';
            output.textContent = 'Starting...';
            output.classList.remove('hidden');
            document.getElementById('sim-action-logs-section').classList.add('hidden');
            document.getElementById('sim-action-modal').classList.remove('hidden');

            const lines = [];
            let okCount = 0, failCount = 0;

            for (const sim of sims) {
                const vendor = sim.vendor || 'unknown';
                const label = (sim.iccid || ('#' + sim.id));
                try {
                    if (vendor === 'wing_iot') {
                        const res = await fetch(API_BASE + '/wing-check', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ iccid: sim.iccid || '' })
                        });
                        const r = await res.json();
                        if (r.ok) {
                            okCount++;
                            lines.push(label + ' [wing_iot]: ' + (r.response && r.response.status ? r.response.status : 'OK'));
                        } else {
                            failCount++;
                            lines.push(label + ' [wing_iot]: ERROR \u2014 ' + JSON.stringify(r.response || r.error));
                        }
                    } else if (vendor === 'atomic') {
                        const res = await fetch(API_BASE + '/atomic-query', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ identifier: sim.iccid || '' })
                        });
                        const r = await res.json();
                        if (r.ok) {
                            const wr = r.response && r.response.wholeSaleApi && r.response.wholeSaleApi.wholeSaleResponse;
                            const attStatus = (wr && wr.Result && wr.Result.attStatus) ? wr.Result.attStatus : (wr && wr.statusCode ? wr.statusCode : 'OK');
                            okCount++;
                            lines.push(label + ' [atomic]: ' + attStatus);
                        } else {
                            failCount++;
                            lines.push(label + ' [atomic]: ERROR \u2014 ' + (r.error || 'unknown'));
                        }
                    } else {
                        // helix
                        const subId = sim.mobility_subscription_id || sim.iccid || '';
                        const res = await fetch(API_BASE + '/helix-query', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ mobility_subscription_id: subId })
                        });
                        const r = await res.json();
                        if (r.ok) {
                            const data = Array.isArray(r.helix_response) ? r.helix_response[0] : r.helix_response;
                            const hStatus = (data && data.status) ? data.status : 'OK';
                            okCount++;
                            lines.push(label + ' [helix]: ' + hStatus);
                        } else {
                            failCount++;
                            lines.push(label + ' [helix]: ERROR \u2014 ' + (r.error || 'unknown'));
                        }
                    }
                } catch (e) {
                    failCount++;
                    lines.push(label + ' [' + vendor + ']: EXCEPTION \u2014 ' + e.message);
                }
                output.textContent = lines.join('\\n');
            }

            lines.unshift('Done: ' + okCount + ' OK, ' + failCount + ' failed\\n');
            output.textContent = lines.join('\\n');
        }`;

if (!content.includes(OLD)) {
  console.error('PATCH FAILED: old string not found. File may have changed.');
  process.exit(1);
}

content = content.replace(OLD, NEW);

// Convert back to CRLF
content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch applied successfully.');
