// _fix_billing_audit.js
// Rewrite Wing Bill Verification → Billing Audit (non-prorated, plan-aware, vendor-agnostic).
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');

// Normalize to LF
content = content.replace(/\r\n/g, '\n');

// ── A. Routes block ──────────────────────────────────────────────────────────
const ROUTES_OLD =
  "    if (url.pathname === '/api/wing-bill/upload' && request.method === 'POST') {\n" +
  "      return handleWingBillUpload(request, env, corsHeaders);\n" +
  "    }\n" +
  "    if (url.pathname === '/api/wing-bill/results') {\n" +
  "      return handleWingBillResults(env, corsHeaders, url);\n" +
  "    }\n" +
  "    if (url.pathname === '/api/wing-bill/uploads') {\n" +
  "      return handleWingBillUploads(env, corsHeaders);\n" +
  "    }\n" +
  "    if (url.pathname === '/api/wing-bill/export') {\n" +
  "      return handleWingBillExport(env, corsHeaders, url);\n" +
  "    }\n" +
  "    if (url.pathname === '/api/wing-bill/backfill-cancel-dates' && request.method === 'POST') {\n" +
  "      return handleBackfillCancelDates(env, corsHeaders);\n" +
  "    }\n";

const ROUTES_NEW =
  "    if (url.pathname === '/api/bill-audit/upload' && request.method === 'POST') {\n" +
  "      return handleBillAuditUpload(request, env, corsHeaders);\n" +
  "    }\n" +
  "    if (url.pathname === '/api/bill-audit/results') {\n" +
  "      return handleBillAuditResults(env, corsHeaders, url);\n" +
  "    }\n" +
  "    if (url.pathname === '/api/bill-audit/uploads') {\n" +
  "      return handleBillAuditUploads(env, corsHeaders);\n" +
  "    }\n" +
  "    if (url.pathname === '/api/bill-audit/export') {\n" +
  "      return handleBillAuditExport(env, corsHeaders, url);\n" +
  "    }\n" +
  "    if (url.pathname === '/api/bill-audit/recompute' && request.method === 'POST') {\n" +
  "      return handleBillAuditRecompute(env, corsHeaders, url);\n" +
  "    }\n" +
  "    if (url.pathname === '/api/bill-audit/backfill-cancel-dates' && request.method === 'POST') {\n" +
  "      return handleBackfillCancelDates(env, corsHeaders);\n" +
  "    }\n";

if (!content.includes(ROUTES_OLD)) { console.error('PATCH FAILED: routes block not found'); process.exit(1); }
content = content.replace(ROUTES_OLD, ROUTES_NEW);

// ── B. Worker handlers block (replace from "// ── Wing Bill Verification" to end of handleBackfillCancelDates) ──
const WB_HEADER = "// ── Wing Bill Verification ────────────────────────────────────────────────────";
const wbStart = content.indexOf(WB_HEADER);
if (wbStart === -1) { console.error('PATCH FAILED: Wing Bill section header not found'); process.exit(1); }
// End is the line "async function handleRelayTest(" — keep until just before it
const nextSection = content.indexOf("async function handleRelayTest(", wbStart);
if (nextSection === -1) { console.error('PATCH FAILED: handleRelayTest marker not found'); process.exit(1); }

const NEW_WORKER_BLOCK =
`// ── Billing Audit (vendor-agnostic, non-prorated) ───────────────────────────
//
// Rate map keyed on Wing's "Bypassed Plan ID" column. Add entries as you
// confirm them on real bills. Lines whose plan ID is NOT in this map skip
// the rate-mismatch check (other checks still run).
const PLAN_RATES = {
    '796': 5.00, // ATT 35MB HX (Helix)
};

const NON_BILLABLE_TERMINAL_STATUSES = new Set(['canceled', 'cancelled', 'error', 'abandoned']);

function parseBillCSV(text) {
    const lines = text.split('\\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) throw new Error('CSV has no data rows');
    const headers = lines[0].split(',').map(h => h.trim());
    return lines.slice(1).map(line => {
        const values = splitCSVLine(line);
        const row = {};
        headers.forEach((h, i) => { row[h] = (values[i] || '').trim(); });
        return row;
    });
}

function splitCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') { inQuotes = !inQuotes; }
        else if (ch === ',' && !inQuotes) { result.push(current); current = ''; }
        else { current += ch; }
    }
    result.push(current);
    return result;
}

async function sbGet(env, path) {
    const resp = await fetch(\`\${env.SUPABASE_URL}/rest/v1/\${path}\`, {
        headers: {
            'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
            'Authorization': \`Bearer \${env.SUPABASE_SERVICE_ROLE_KEY}\`,
        }
    });
    return resp.json();
}

async function sbPost(env, table, data) {
    const resp = await fetch(\`\${env.SUPABASE_URL}/rest/v1/\${table}\`, {
        method: 'POST',
        headers: {
            'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
            'Authorization': \`Bearer \${env.SUPABASE_SERVICE_ROLE_KEY}\`,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation',
        },
        body: JSON.stringify(data),
    });
    return resp.json();
}

async function sbPatch(env, path, data) {
    await fetch(\`\${env.SUPABASE_URL}/rest/v1/\${path}\`, {
        method: 'PATCH',
        headers: {
            'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
            'Authorization': \`Bearer \${env.SUPABASE_SERVICE_ROLE_KEY}\`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal',
        },
        body: JSON.stringify(data),
    });
}

// Find the most recent transition into a non-billable terminal status for this SIM.
// Returns ISO timestamp or null.
function findCancelTimestamp(history) {
    if (!history || !history.length) return null;
    const cancels = history.filter(h => NON_BILLABLE_TERMINAL_STATUSES.has((h.new_status || '').toLowerCase()));
    if (!cancels.length) return null;
    cancels.sort((a, b) => new Date(b.changed_at) - new Date(a.changed_at));
    return cancels[0].changed_at;
}

// Apply the five audit checks to one parsed row. Returns { discrepancyType, discrepancyDetail, expectedPrice }.
function auditOneLine({ row, sim, history, fromDate }) {
    const price = parseFloat(row['Price'] || '0');
    const planId = (row['Bypassed Plan ID'] || '').trim() || null;
    const knownRate = planId && PLAN_RATES[planId] != null ? PLAN_RATES[planId] : null;

    if (!sim) {
        return { discrepancyType: 'unknown_iccid', discrepancyDetail: \`ICCID \${row['Subscription Iccid'] || '(blank)'} not found in our system\`, expectedPrice: 0 };
    }

    if (NON_BILLABLE_TERMINAL_STATUSES.has((sim.status || '').toLowerCase())) {
        const canceledAt = findCancelTimestamp(history);
        if (canceledAt && fromDate && new Date(canceledAt) < fromDate) {
            const dt = new Date(canceledAt).toISOString().split('T')[0];
            return { discrepancyType: 'canceled_before_period', discrepancyDetail: \`SIM was \${sim.status} as of \${dt}, before bill period start\`, expectedPrice: 0 };
        }
        // No history record but currently canceled — assume canceled before period (safe flag)
        if (!canceledAt) {
            return { discrepancyType: 'canceled_before_period', discrepancyDetail: \`SIM is \${sim.status} (no cancel-date record); flag for review\`, expectedPrice: 0 };
        }
    }

    if (knownRate != null && Math.abs(price - knownRate) > 0.01) {
        return { discrepancyType: 'rate_mismatch', discrepancyDetail: \`Plan \${planId} expected $\${knownRate.toFixed(2)} but charged $\${price.toFixed(2)}\`, expectedPrice: knownRate };
    }

    return { discrepancyType: null, discrepancyDetail: null, expectedPrice: knownRate != null ? knownRate : price };
}

async function handleBillAuditUpload(request, env, corsHeaders) {
    try {
        const formData = await request.formData();
        const file = formData.get('file');
        if (!file) return new Response(JSON.stringify({ error: 'No file uploaded' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        const csvText = await file.text();
        const filename = file.name || 'bill.csv';
        const vendor = (new URL(request.url)).searchParams.get('vendor') || 'wing';

        const rows = parseBillCSV(csvText);
        if (!rows.length) return new Response(JSON.stringify({ error: 'CSV has no data rows' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

        const [upload] = await sbPost(env, 'bill_audit_uploads', { filename, vendor, total_rows: rows.length, status: 'processing' });
        const uploadId = upload.id;

        const allSims = await sbGet(env, 'sims?select=id,iccid,status&limit=10000');
        const simsByIccid = {};
        (allSims || []).forEach(s => { simsByIccid[s.iccid] = s; });

        // Pre-resolve sim objects + collect IDs whose history we need (only canceled-status SIMs need it)
        const simIds = new Set();
        const parsedRows = rows.map(row => {
            const iccid = row['Subscription Iccid'] || '';
            const sim = simsByIccid[iccid];
            if (sim && NON_BILLABLE_TERMINAL_STATUSES.has((sim.status || '').toLowerCase())) simIds.add(sim.id);
            return { row, iccid, sim };
        });

        let allHistory = [];
        if (simIds.size > 0) {
            const idList = [...simIds].join(',');
            allHistory = await sbGet(env, \`sim_status_history?sim_id=in.(\${idList})&order=changed_at.desc&limit=50000\`) || [];
        }
        const historyBySimId = {};
        allHistory.forEach(h => {
            if (!historyBySimId[h.sim_id]) historyBySimId[h.sim_id] = [];
            historyBySimId[h.sim_id].push(h);
        });

        const billedIccids = new Set();
        const lineRecords = [];

        for (const { row, iccid, sim } of parsedRows) {
            const price = parseFloat(row['Price'] || '0');
            const fromDate = row['From Date'] ? new Date(row['From Date']) : null;
            const toDate = row['To Date'] ? new Date(row['To Date']) : null;
            const planId = (row['Bypassed Plan ID'] || '').trim() || null;
            const history = sim ? (historyBySimId[sim.id] || []) : [];

            const audit = auditOneLine({ row, sim, history, fromDate });

            billedIccids.add(iccid);
            lineRecords.push({
                upload_id: uploadId,
                vendor,
                wing_id: row['Id'] || null,
                item_type: row['Item Type'] || null,
                description: row['Description'] || null,
                from_date: fromDate?.toISOString() || null,
                to_date: toDate?.toISOString() || null,
                subscription_name: row['Subscription Name'] || null,
                subscription_iccid: iccid || null,
                subscription_identifier: row['Subscription Identifier'] || null,
                bypassed_plan_id: planId,
                carrier: row['Carrier'] || null,
                price,
                sim_id: sim?.id || null,
                sim_status: sim?.status || null,
                expected_price: audit.expectedPrice,
                discrepancy_type: audit.discrepancyType,
                discrepancy_detail: audit.discrepancyDetail,
            });
        }

        // Duplicate-charge detection: same ICCID with overlapping periods within this upload
        const byIccid = {};
        lineRecords.forEach(r => {
            if (!r.subscription_iccid) return;
            if (!byIccid[r.subscription_iccid]) byIccid[r.subscription_iccid] = [];
            byIccid[r.subscription_iccid].push(r);
        });
        for (const entries of Object.values(byIccid)) {
            if (entries.length < 2) continue;
            for (let i = 0; i < entries.length; i++) {
                for (let j = i + 1; j < entries.length; j++) {
                    const a = entries[i], b = entries[j];
                    if (a.from_date && b.from_date && a.to_date && b.to_date) {
                        const aFrom = new Date(a.from_date), aTo = new Date(a.to_date);
                        const bFrom = new Date(b.from_date), bTo = new Date(b.to_date);
                        if (aFrom < bTo && bFrom < aTo && !b.discrepancy_type) {
                            b.discrepancy_type = 'duplicate_charge';
                            b.discrepancy_detail = \`Overlapping period with line \${a.wing_id || a.subscription_iccid}\`;
                            b.expected_price = 0;
                        }
                    }
                }
            }
        }

        const activeSims = (allSims || []).filter(s => !NON_BILLABLE_TERMINAL_STATUSES.has((s.status || '').toLowerCase()) && s.status !== 'provisioning');
        const missingFromBill = activeSims.filter(s => !billedIccids.has(s.iccid));

        for (let i = 0; i < lineRecords.length; i += 500) {
            const batch = lineRecords.slice(i, i + 500);
            await fetch(\`\${env.SUPABASE_URL}/rest/v1/bill_audit_lines\`, {
                method: 'POST',
                headers: {
                    'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
                    'Authorization': \`Bearer \${env.SUPABASE_SERVICE_ROLE_KEY}\`,
                    'Content-Type': 'application/json',
                    'Prefer': 'return=minimal',
                },
                body: JSON.stringify(batch),
            });
        }

        const discrepancyCount = lineRecords.filter(r => r.discrepancy_type).length;
        const totalAmount = lineRecords.reduce((sum, r) => sum + (r.price || 0), 0);
        const totalExpected = lineRecords.reduce((sum, r) => sum + (r.expected_price || 0), 0);
        const overchargeAmount = Math.max(0, Math.round((totalAmount - totalExpected) * 100) / 100);
        const dates = lineRecords.map(r => r.from_date).filter(Boolean).sort();
        const endDates = lineRecords.map(r => r.to_date).filter(Boolean).sort();

        await sbPatch(env, \`bill_audit_uploads?id=eq.\${uploadId}\`, {
            status: 'complete',
            total_amount: totalAmount,
            total_expected: totalExpected,
            overcharge_amount: overchargeAmount,
            discrepancy_count: discrepancyCount,
            billing_period_start: dates[0] ? dates[0].split('T')[0] : null,
            billing_period_end: endDates.length ? endDates[endDates.length - 1].split('T')[0] : null,
        });

        return new Response(JSON.stringify({
            upload_id: uploadId,
            vendor,
            total_rows: lineRecords.length,
            total_amount: totalAmount,
            total_expected: totalExpected,
            overcharge_amount: overchargeAmount,
            discrepancy_count: discrepancyCount,
            discrepancies: lineRecords.filter(r => r.discrepancy_type),
            missing_from_bill: missingFromBill.map(s => ({ sim_id: s.id, iccid: s.iccid, status: s.status })),
            missing_count: missingFromBill.length,
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    } catch (e) {
        console.error('Bill audit upload error:', e);
        return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
}

async function handleBillAuditResults(env, corsHeaders, url) {
    const uploadId = url.searchParams.get('upload_id');
    if (!uploadId) return new Response(JSON.stringify({ error: 'upload_id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const [uploads, lines] = await Promise.all([
        sbGet(env, \`bill_audit_uploads?id=eq.\${encodeURIComponent(uploadId)}&limit=1\`),
        sbGet(env, \`bill_audit_lines?upload_id=eq.\${encodeURIComponent(uploadId)}&order=id.asc&limit=10000\`),
    ]);

    const upload = Array.isArray(uploads) ? uploads[0] : null;
    if (!upload) return new Response(JSON.stringify({ error: 'Upload not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    return new Response(JSON.stringify({
        upload,
        lines: lines || [],
        discrepancies: (lines || []).filter(l => l.discrepancy_type),
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

async function handleBillAuditUploads(env, corsHeaders) {
    const data = await sbGet(env, 'bill_audit_uploads?select=id,vendor,filename,billing_period_start,billing_period_end,total_rows,total_amount,total_expected,overcharge_amount,discrepancy_count,status,created_at&order=created_at.desc&limit=50');
    return new Response(JSON.stringify(data || []), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

async function handleBillAuditExport(env, corsHeaders, url) {
    const uploadId = url.searchParams.get('upload_id');
    if (!uploadId) return new Response('upload_id required', { status: 400 });

    const [uploads, lines] = await Promise.all([
        sbGet(env, \`bill_audit_uploads?id=eq.\${encodeURIComponent(uploadId)}&limit=1\`),
        sbGet(env, \`bill_audit_lines?upload_id=eq.\${encodeURIComponent(uploadId)}&order=id.asc&limit=10000\`),
    ]);

    const upload = Array.isArray(uploads) ? uploads[0] : null;
    if (!upload) return new Response('Upload not found', { status: 404 });

    const auditLabels = {
        'unknown_iccid': 'UNKNOWN ICCID',
        'canceled_before_period': 'CANCELED BEFORE PERIOD',
        'rate_mismatch': 'RATE MISMATCH',
        'duplicate_charge': 'DUPLICATE',
    };

    const csvHeaders = 'Bill Line ID,ICCID,Description,Plan ID,Carrier,From Date,To Date,Billed Amount,Expected Amount,Overcharge,SIM Status,Audit Result,Detail';
    const csvRows = (lines || []).map(l => {
        const overcharge = Math.max(0, (l.price || 0) - (l.expected_price || 0));
        const auditResult = l.discrepancy_type ? auditLabels[l.discrepancy_type] || l.discrepancy_type : 'OK';
        return [
            l.wing_id || '',
            l.subscription_iccid || '',
            \`"\${(l.description || '').replace(/"/g, '""')}"\`,
            l.bypassed_plan_id || '',
            l.carrier || '',
            l.from_date ? new Date(l.from_date).toLocaleDateString('en-US') : '',
            l.to_date ? new Date(l.to_date).toLocaleDateString('en-US') : '',
            (l.price || 0).toFixed(2),
            (l.expected_price || 0).toFixed(2),
            overcharge.toFixed(2),
            l.sim_status || 'N/A',
            auditResult,
            \`"\${(l.discrepancy_detail || '').replace(/"/g, '""')}"\`,
        ].join(',');
    });

    const totalBilled = (lines || []).reduce((s, l) => s + (l.price || 0), 0);
    const totalExpected = (lines || []).reduce((s, l) => s + (l.expected_price || 0), 0);
    const totalOvercharge = Math.max(0, totalBilled - totalExpected);
    csvRows.push('');
    csvRows.push(\`,,,,,,,\${totalBilled.toFixed(2)},\${totalExpected.toFixed(2)},\${totalOvercharge.toFixed(2)},,"TOTALS",\`);

    const csv = csvHeaders + '\\n' + csvRows.join('\\n');
    const invoiceName = (upload.filename || '').replace(/\\.[^.]+$/, '') || \`upload-\${uploadId}\`;
    const exportFilename = \`\${invoiceName} - Audit.csv\`;

    return new Response(csv, {
        headers: {
            ...corsHeaders,
            'Content-Type': 'text/csv',
            'Content-Disposition': \`attachment; filename="\${exportFilename}"\`,
        },
    });
}

// One-time: re-evaluate discrepancies for existing bill_audit_lines using current logic.
// POST /api/bill-audit/recompute             — recomputes ALL uploads
// POST /api/bill-audit/recompute?upload_id=X — recomputes one upload
async function handleBillAuditRecompute(env, corsHeaders, url) {
    try {
        const filterUploadId = url.searchParams.get('upload_id');
        const uploadFilter = filterUploadId ? \`?id=eq.\${encodeURIComponent(filterUploadId)}\` : '?order=id.asc&limit=200';
        const uploads = await sbGet(env, \`bill_audit_uploads\${uploadFilter}\`);
        if (!uploads || !uploads.length) {
            return new Response(JSON.stringify({ ok: true, message: 'No uploads to recompute', uploads_processed: 0 }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        const allSims = await sbGet(env, 'sims?select=id,iccid,status&limit=10000');
        const simsByIccid = {};
        (allSims || []).forEach(s => { simsByIccid[s.iccid] = s; });

        const summary = [];

        for (const upload of uploads) {
            const lines = await sbGet(env, \`bill_audit_lines?upload_id=eq.\${upload.id}&order=id.asc&limit=10000\`) || [];
            if (!lines.length) { summary.push({ upload_id: upload.id, lines: 0, skipped: true }); continue; }

            const simIds = new Set();
            lines.forEach(l => {
                const sim = l.subscription_iccid ? simsByIccid[l.subscription_iccid] : null;
                if (sim && NON_BILLABLE_TERMINAL_STATUSES.has((sim.status || '').toLowerCase())) simIds.add(sim.id);
            });
            let history = [];
            if (simIds.size > 0) {
                history = await sbGet(env, \`sim_status_history?sim_id=in.(\${[...simIds].join(',')})&order=changed_at.desc&limit=50000\`) || [];
            }
            const historyBySimId = {};
            history.forEach(h => {
                if (!historyBySimId[h.sim_id]) historyBySimId[h.sim_id] = [];
                historyBySimId[h.sim_id].push(h);
            });

            // First pass: per-line audit
            const updated = lines.map(l => {
                const iccid = l.subscription_iccid || '';
                const sim = simsByIccid[iccid] || null;
                const fromDate = l.from_date ? new Date(l.from_date) : null;
                const row = {
                    'Subscription Iccid': iccid,
                    'Bypassed Plan ID': l.bypassed_plan_id || '',
                    'Price': String(l.price || 0),
                };
                const audit = auditOneLine({ row, sim, history: sim ? (historyBySimId[sim.id] || []) : [], fromDate });
                return {
                    ...l,
                    sim_id: sim?.id || null,
                    sim_status: sim?.status || null,
                    discrepancy_type: audit.discrepancyType,
                    discrepancy_detail: audit.discrepancyDetail,
                    expected_price: audit.expectedPrice,
                };
            });

            // Second pass: duplicate-charge across upload
            const byIccid = {};
            updated.forEach(r => {
                if (!r.subscription_iccid) return;
                if (!byIccid[r.subscription_iccid]) byIccid[r.subscription_iccid] = [];
                byIccid[r.subscription_iccid].push(r);
            });
            for (const entries of Object.values(byIccid)) {
                if (entries.length < 2) continue;
                for (let i = 0; i < entries.length; i++) {
                    for (let j = i + 1; j < entries.length; j++) {
                        const a = entries[i], b = entries[j];
                        if (a.from_date && b.from_date && a.to_date && b.to_date) {
                            const aFrom = new Date(a.from_date), aTo = new Date(a.to_date);
                            const bFrom = new Date(b.from_date), bTo = new Date(b.to_date);
                            if (aFrom < bTo && bFrom < aTo && !b.discrepancy_type) {
                                b.discrepancy_type = 'duplicate_charge';
                                b.discrepancy_detail = \`Overlapping period with line \${a.wing_id || a.subscription_iccid}\`;
                                b.expected_price = 0;
                            }
                        }
                    }
                }
            }

            // Persist line-level updates (one PATCH per line — simple and small N)
            for (const r of updated) {
                await sbPatch(env, \`bill_audit_lines?id=eq.\${r.id}\`, {
                    sim_id: r.sim_id,
                    sim_status: r.sim_status,
                    discrepancy_type: r.discrepancy_type,
                    discrepancy_detail: r.discrepancy_detail,
                    expected_price: r.expected_price,
                });
            }

            const totalAmount = updated.reduce((s, r) => s + (r.price || 0), 0);
            const totalExpected = updated.reduce((s, r) => s + (r.expected_price || 0), 0);
            const overcharge = Math.max(0, Math.round((totalAmount - totalExpected) * 100) / 100);
            const discCount = updated.filter(r => r.discrepancy_type).length;
            await sbPatch(env, \`bill_audit_uploads?id=eq.\${upload.id}\`, {
                total_amount: totalAmount,
                total_expected: totalExpected,
                overcharge_amount: overcharge,
                discrepancy_count: discCount,
            });

            summary.push({ upload_id: upload.id, filename: upload.filename, lines: updated.length, discrepancies: discCount, overcharge });
        }

        return new Response(JSON.stringify({ ok: true, uploads_processed: summary.length, summary }, null, 2), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
}

`;

content = content.slice(0, wbStart) + NEW_WORKER_BLOCK + content.slice(nextSection);

// ── C. HTML section (replace "Wing Bill Verification" card + its history table) ──
const HTML_OLD =
`                <!-- Wing Bill Verification -->
                <div class="bg-dark-800 rounded-xl p-5 border border-dark-600 mb-6 mt-8">
                    <div class="flex items-center justify-between mb-3">
                        <h3 class="text-lg font-semibold text-white">Wing Bill Verification</h3>
                    </div>
                    <p class="text-sm text-gray-400 mb-4">Upload the Wing/Helix itemized CSV to cross-reference against SIM records and detect billing discrepancies.</p>

                    <div class="flex flex-wrap items-end gap-3 mb-4">
                        <div class="flex flex-col gap-1">
                            <label class="text-xs text-gray-500 uppercase">CSV File</label>
                            <input type="file" id="wing-csv-file" accept=".csv" class="text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300">
                        </div>
                        <button onclick="uploadWingBill()" id="wing-upload-btn" class="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition">
                            Verify Bill
                        </button>
                    </div>

                    <div id="wing-summary" class="hidden mb-4">
                        <div class="grid grid-cols-2 md:grid-cols-6 gap-3 mb-4">
                            <div class="bg-dark-700 rounded-lg p-3 border border-dark-600">
                                <p class="text-xs text-gray-500 uppercase">Total Lines</p>
                                <p class="text-xl font-bold text-white" id="wing-total-rows">0</p>
                            </div>
                            <div class="bg-dark-700 rounded-lg p-3 border border-dark-600">
                                <p class="text-xs text-gray-500 uppercase">Total Billed</p>
                                <p class="text-xl font-bold text-white" id="wing-total-amount">$0.00</p>
                            </div>
                            <div class="bg-dark-700 rounded-lg p-3 border border-dark-600">
                                <p class="text-xs text-gray-500 uppercase">Expected</p>
                                <p class="text-xl font-bold text-accent" id="wing-total-expected">$0.00</p>
                            </div>
                            <div class="bg-dark-700 rounded-lg p-3 border border-dark-600">
                                <p class="text-xs text-gray-500 uppercase">Overcharge</p>
                                <p class="text-xl font-bold text-red-400" id="wing-overcharge">$0.00</p>
                            </div>
                            <div class="bg-dark-700 rounded-lg p-3 border border-dark-600">
                                <p class="text-xs text-gray-500 uppercase">Discrepancies</p>
                                <p class="text-xl font-bold" id="wing-discrepancy-count">0</p>
                            </div>
                            <div class="bg-dark-700 rounded-lg p-3 border border-dark-600">
                                <p class="text-xs text-gray-500 uppercase">Missing from Bill</p>
                                <p class="text-xl font-bold text-yellow-400" id="wing-missing-count">0</p>
                            </div>
                        </div>
                        <button onclick="exportWingAudit(window._wingUploadId)" id="wing-export-btn" class="px-4 py-2 text-sm bg-accent hover:bg-green-600 text-white rounded-lg transition mb-4">
                            Export Audit Report (CSV)
                        </button>
                    </div>

                    <div id="wing-discrepancies" class="hidden mb-4">
                        <h4 class="text-sm font-semibold text-red-400 uppercase mb-2">Discrepancies Found</h4>
                        <div class="overflow-x-auto max-h-96 overflow-y-auto">
                            <table class="w-full text-sm">
                                <thead class="sticky top-0 bg-dark-800">
                                    <tr class="text-left text-xs text-gray-500 uppercase border-b border-dark-600">
                                        <th class="px-3 py-2 font-medium">Type</th>
                                        <th class="px-3 py-2 font-medium">ICCID</th>
                                        <th class="px-3 py-2 font-medium">Description</th>
                                        <th class="px-3 py-2 font-medium">Period</th>
                                        <th class="px-3 py-2 font-medium">Billed</th>
                                        <th class="px-3 py-2 font-medium">Expected</th>
                                        <th class="px-3 py-2 font-medium">Days</th>
                                        <th class="px-3 py-2 font-medium">Status</th>
                                        <th class="px-3 py-2 font-medium">Detail</th>
                                    </tr>
                                </thead>
                                <tbody id="wing-discrepancy-table"></tbody>
                            </table>
                        </div>
                    </div>

                    <div id="wing-missing" class="hidden mb-4">
                        <h4 class="text-sm font-semibold text-yellow-400 uppercase mb-2">Active SIMs Missing from Bill</h4>
                        <div class="overflow-x-auto max-h-48 overflow-y-auto">
                            <table class="w-full text-sm">
                                <thead class="sticky top-0 bg-dark-800">
                                    <tr class="text-left text-xs text-gray-500 uppercase border-b border-dark-600">
                                        <th class="px-3 py-2 font-medium">SIM ID</th>
                                        <th class="px-3 py-2 font-medium">ICCID</th>
                                        <th class="px-3 py-2 font-medium">Status</th>
                                    </tr>
                                </thead>
                                <tbody id="wing-missing-table"></tbody>
                            </table>
                        </div>
                    </div>
                </div>

                <!-- Wing Verification History -->
                <div class="bg-dark-800 rounded-xl p-5 border border-dark-600">
                    <h3 class="text-lg font-semibold text-white mb-3">Verification History</h3>
                    <div class="overflow-x-auto">
                        <table class="w-full">
                            <thead>
                                <tr class="text-left text-xs text-gray-500 uppercase border-b border-dark-600">
                                    <th class="px-4 py-3 font-medium">Date</th>
                                    <th class="px-4 py-3 font-medium">File</th>
                                    <th class="px-4 py-3 font-medium">Period</th>
                                    <th class="px-4 py-3 font-medium">Lines</th>
                                    <th class="px-4 py-3 font-medium">Billed</th>
                                    <th class="px-4 py-3 font-medium">Overcharge</th>
                                    <th class="px-4 py-3 font-medium">Issues</th>
                                    <th class="px-4 py-3 font-medium">Actions</th>
                                </tr>
                            </thead>
                            <tbody id="wing-history-table" class="text-sm">
                                <tr><td colspan="8" class="px-4 py-4 text-center text-gray-500">No verifications yet</td></tr>
                            </tbody>
                        </table>
                    </div>
                </div>`;

const HTML_NEW =
`                <!-- Billing Audit -->
                <div class="bg-dark-800 rounded-xl p-5 border border-dark-600 mb-6 mt-8">
                    <div class="flex items-center justify-between mb-3">
                        <h3 class="text-lg font-semibold text-white">Billing Audit</h3>
                    </div>
                    <p class="text-sm text-gray-400 mb-4">Upload a vendor itemized CSV (Wing today; Teltik later) to cross-reference against SIM records. Wing bills full month per line — no proration. Checks: unknown ICCID, canceled before period start, plan rate mismatch, duplicate line, active SIMs missing from bill.</p>

                    <div class="flex flex-wrap items-end gap-3 mb-4">
                        <div class="flex flex-col gap-1">
                            <label class="text-xs text-gray-500 uppercase">Vendor</label>
                            <select id="audit-vendor" class="text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300">
                                <option value="wing">Wing</option>
                            </select>
                        </div>
                        <div class="flex flex-col gap-1">
                            <label class="text-xs text-gray-500 uppercase">CSV File</label>
                            <input type="file" id="audit-csv-file" accept=".csv" class="text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300">
                        </div>
                        <button onclick="uploadBillAudit()" id="audit-upload-btn" class="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition">
                            Run Audit
                        </button>
                    </div>

                    <div id="audit-summary" class="hidden mb-4">
                        <div class="grid grid-cols-2 md:grid-cols-6 gap-3 mb-4">
                            <div class="bg-dark-700 rounded-lg p-3 border border-dark-600">
                                <p class="text-xs text-gray-500 uppercase">Total Lines</p>
                                <p class="text-xl font-bold text-white" id="audit-total-rows">0</p>
                            </div>
                            <div class="bg-dark-700 rounded-lg p-3 border border-dark-600">
                                <p class="text-xs text-gray-500 uppercase">Total Billed</p>
                                <p class="text-xl font-bold text-white" id="audit-total-amount">$0.00</p>
                            </div>
                            <div class="bg-dark-700 rounded-lg p-3 border border-dark-600">
                                <p class="text-xs text-gray-500 uppercase">Expected</p>
                                <p class="text-xl font-bold text-accent" id="audit-total-expected">$0.00</p>
                            </div>
                            <div class="bg-dark-700 rounded-lg p-3 border border-dark-600">
                                <p class="text-xs text-gray-500 uppercase">Overcharge</p>
                                <p class="text-xl font-bold text-red-400" id="audit-overcharge">$0.00</p>
                            </div>
                            <div class="bg-dark-700 rounded-lg p-3 border border-dark-600">
                                <p class="text-xs text-gray-500 uppercase">Discrepancies</p>
                                <p class="text-xl font-bold" id="audit-discrepancy-count">0</p>
                            </div>
                            <div class="bg-dark-700 rounded-lg p-3 border border-dark-600">
                                <p class="text-xs text-gray-500 uppercase">Missing from Bill</p>
                                <p class="text-xl font-bold text-yellow-400" id="audit-missing-count">0</p>
                            </div>
                        </div>
                        <button onclick="exportBillAudit(window._auditUploadId)" id="audit-export-btn" class="px-4 py-2 text-sm bg-accent hover:bg-green-600 text-white rounded-lg transition mb-4">
                            Export Audit Report (CSV)
                        </button>
                    </div>

                    <div id="audit-discrepancies" class="hidden mb-4">
                        <h4 class="text-sm font-semibold text-red-400 uppercase mb-2">Discrepancies Found</h4>
                        <div class="overflow-x-auto max-h-96 overflow-y-auto">
                            <table class="w-full text-sm">
                                <thead class="sticky top-0 bg-dark-800">
                                    <tr class="text-left text-xs text-gray-500 uppercase border-b border-dark-600">
                                        <th class="px-3 py-2 font-medium">Type</th>
                                        <th class="px-3 py-2 font-medium">ICCID</th>
                                        <th class="px-3 py-2 font-medium">Description</th>
                                        <th class="px-3 py-2 font-medium">Plan</th>
                                        <th class="px-3 py-2 font-medium">Period</th>
                                        <th class="px-3 py-2 font-medium">Billed</th>
                                        <th class="px-3 py-2 font-medium">Expected</th>
                                        <th class="px-3 py-2 font-medium">Status</th>
                                        <th class="px-3 py-2 font-medium">Detail</th>
                                    </tr>
                                </thead>
                                <tbody id="audit-discrepancy-table"></tbody>
                            </table>
                        </div>
                    </div>

                    <div id="audit-missing" class="hidden mb-4">
                        <h4 class="text-sm font-semibold text-yellow-400 uppercase mb-2">Active SIMs Missing from Bill</h4>
                        <div class="overflow-x-auto max-h-48 overflow-y-auto">
                            <table class="w-full text-sm">
                                <thead class="sticky top-0 bg-dark-800">
                                    <tr class="text-left text-xs text-gray-500 uppercase border-b border-dark-600">
                                        <th class="px-3 py-2 font-medium">SIM ID</th>
                                        <th class="px-3 py-2 font-medium">ICCID</th>
                                        <th class="px-3 py-2 font-medium">Status</th>
                                    </tr>
                                </thead>
                                <tbody id="audit-missing-table"></tbody>
                            </table>
                        </div>
                    </div>
                </div>

                <!-- Audit History -->
                <div class="bg-dark-800 rounded-xl p-5 border border-dark-600">
                    <h3 class="text-lg font-semibold text-white mb-3">Audit History</h3>
                    <div class="overflow-x-auto">
                        <table class="w-full">
                            <thead>
                                <tr class="text-left text-xs text-gray-500 uppercase border-b border-dark-600">
                                    <th class="px-4 py-3 font-medium">Date</th>
                                    <th class="px-4 py-3 font-medium">Vendor</th>
                                    <th class="px-4 py-3 font-medium">File</th>
                                    <th class="px-4 py-3 font-medium">Period</th>
                                    <th class="px-4 py-3 font-medium">Lines</th>
                                    <th class="px-4 py-3 font-medium">Billed</th>
                                    <th class="px-4 py-3 font-medium">Overcharge</th>
                                    <th class="px-4 py-3 font-medium">Issues</th>
                                    <th class="px-4 py-3 font-medium">Actions</th>
                                </tr>
                            </thead>
                            <tbody id="audit-history-table" class="text-sm">
                                <tr><td colspan="9" class="px-4 py-4 text-center text-gray-500">No audits yet</td></tr>
                            </tbody>
                        </table>
                    </div>
                </div>`;

if (!content.includes(HTML_OLD)) { console.error('PATCH FAILED: HTML section not found'); process.exit(1); }
content = content.replace(HTML_OLD, HTML_NEW);

// ── D. Frontend JS section ──
const JS_OLD_HEADER = "        // ===== Wing Bill Verification =====";
const jsStart = content.indexOf(JS_OLD_HEADER);
if (jsStart === -1) { console.error('PATCH FAILED: Frontend JS header not found'); process.exit(1); }
// End: just before "        // Close any visible modal on Escape key or backdrop click"
const jsEndMarker = "        // Close any visible modal on Escape key or backdrop click";
const jsEnd = content.indexOf(jsEndMarker, jsStart);
if (jsEnd === -1) { console.error('PATCH FAILED: Frontend JS end marker not found'); process.exit(1); }

// Build new frontend JS — uses single quotes for outer worker string (it's all inside getHTML template).
// Inner template literals must have escaped backticks/$. Use string concat to be safe.
const BT = '\\' + '`';   // \`
const DS = '\\' + '${';  // \${

const NEW_JS =
"        // ===== Billing Audit =====\n" +
"\n" +
"        async function uploadBillAudit() {\n" +
"            const fileInput = document.getElementById('audit-csv-file');\n" +
"            if (!fileInput.files.length) { showToast('Select a CSV file first', 'error'); return; }\n" +
"            const file = fileInput.files[0];\n" +
"            const vendor = document.getElementById('audit-vendor').value || 'wing';\n" +
"            const btn = document.getElementById('audit-upload-btn');\n" +
"            btn.disabled = true; btn.textContent = 'Running...';\n" +
"            try {\n" +
"                const formData = new FormData();\n" +
"                formData.append('file', file);\n" +
"                const resp = await fetch(API_BASE + '/bill-audit/upload?vendor=' + encodeURIComponent(vendor), {\n" +
"                    method: 'POST',\n" +
"                    credentials: 'include',\n" +
"                    body: formData,\n" +
"                });\n" +
"                const data = await resp.json();\n" +
"                if (data.error) { showToast(data.error, 'error'); return; }\n" +
"                window._auditUploadId = data.upload_id;\n" +
"                renderBillAuditResults(data);\n" +
"                loadBillAuditHistory();\n" +
"                showToast('Audit complete: ' + data.discrepancy_count + ' discrepancies, $' + Number(data.overcharge_amount).toFixed(2) + ' overcharge',\n" +
"                    data.discrepancy_count > 0 ? 'error' : 'success');\n" +
"            } catch (e) {\n" +
"                showToast('Upload failed: ' + e, 'error');\n" +
"            } finally {\n" +
"                btn.disabled = false; btn.textContent = 'Run Audit';\n" +
"            }\n" +
"        }\n" +
"\n" +
"        function renderBillAuditResults(data) {\n" +
"            document.getElementById('audit-summary').classList.remove('hidden');\n" +
"            document.getElementById('audit-total-rows').textContent = data.total_rows;\n" +
"            document.getElementById('audit-total-amount').textContent = '$' + Number(data.total_amount).toFixed(2);\n" +
"            document.getElementById('audit-total-expected').textContent = '$' + Number(data.total_expected).toFixed(2);\n" +
"            document.getElementById('audit-overcharge').textContent = '$' + Number(data.overcharge_amount).toFixed(2);\n" +
"            const discEl = document.getElementById('audit-discrepancy-count');\n" +
"            discEl.textContent = data.discrepancy_count;\n" +
"            discEl.className = 'text-xl font-bold ' + (data.discrepancy_count > 0 ? 'text-red-400' : 'text-accent');\n" +
"            document.getElementById('audit-missing-count').textContent = data.missing_count || 0;\n" +
"\n" +
"            const typeColors = {\n" +
"                'unknown_iccid': 'text-purple-400',\n" +
"                'canceled_before_period': 'text-red-400',\n" +
"                'rate_mismatch': 'text-yellow-400',\n" +
"                'duplicate_charge': 'text-pink-400',\n" +
"            };\n" +
"            const typeLabels = {\n" +
"                'unknown_iccid': 'Unknown ICCID',\n" +
"                'canceled_before_period': 'Canceled Before Period',\n" +
"                'rate_mismatch': 'Rate Mismatch',\n" +
"                'duplicate_charge': 'Duplicate',\n" +
"            };\n" +
"\n" +
"            const discSection = document.getElementById('audit-discrepancies');\n" +
"            const discTable = document.getElementById('audit-discrepancy-table');\n" +
"            if (data.discrepancies && data.discrepancies.length > 0) {\n" +
"                discSection.classList.remove('hidden');\n" +
"                discTable.innerHTML = data.discrepancies.map(d => '<tr class=" + '"' + "border-b border-dark-700" + '"' + ">' +\n" +
"                    '<td class=" + '"' + "px-3 py-2 ' + (typeColors[d.discrepancy_type] || 'text-gray-300') + ' font-medium text-xs" + '"' + ">' + (typeLabels[d.discrepancy_type] || d.discrepancy_type) + '</td>' +\n" +
"                    '<td class=" + '"' + "px-3 py-2 text-gray-300 font-mono text-xs" + '"' + ">' + (d.subscription_iccid || '-') + '</td>' +\n" +
"                    '<td class=" + '"' + "px-3 py-2 text-gray-400" + '"' + ">' + (d.description || '-') + '</td>' +\n" +
"                    '<td class=" + '"' + "px-3 py-2 text-gray-400 text-xs" + '"' + ">' + (d.bypassed_plan_id || '-') + '</td>' +\n" +
"                    '<td class=" + '"' + "px-3 py-2 text-gray-400 text-xs" + '"' + ">' + formatAuditDate(d.from_date) + ' - ' + formatAuditDate(d.to_date) + '</td>' +\n" +
"                    '<td class=" + '"' + "px-3 py-2 text-gray-300" + '"' + ">$' + Number(d.price).toFixed(2) + '</td>' +\n" +
"                    '<td class=" + '"' + "px-3 py-2 text-accent" + '"' + ">$' + Number(d.expected_price || 0).toFixed(2) + '</td>' +\n" +
"                    '<td class=" + '"' + "px-3 py-2 text-gray-400" + '"' + ">' + (d.sim_status || 'N/A') + '</td>' +\n" +
"                    '<td class=" + '"' + "px-3 py-2 text-gray-400 text-xs" + '"' + ">' + (d.discrepancy_detail || '') + '</td>' +\n" +
"                    '</tr>').join('');\n" +
"            } else {\n" +
"                discSection.classList.add('hidden');\n" +
"            }\n" +
"\n" +
"            const missingSection = document.getElementById('audit-missing');\n" +
"            const missingTable = document.getElementById('audit-missing-table');\n" +
"            if (data.missing_from_bill && data.missing_from_bill.length > 0) {\n" +
"                missingSection.classList.remove('hidden');\n" +
"                missingTable.innerHTML = data.missing_from_bill.map(s => '<tr class=" + '"' + "border-b border-dark-700" + '"' + ">' +\n" +
"                    '<td class=" + '"' + "px-3 py-2 text-gray-300" + '"' + ">' + s.sim_id + '</td>' +\n" +
"                    '<td class=" + '"' + "px-3 py-2 text-gray-300 font-mono text-xs" + '"' + ">' + s.iccid + '</td>' +\n" +
"                    '<td class=" + '"' + "px-3 py-2 text-gray-400" + '"' + ">' + s.status + '</td>' +\n" +
"                    '</tr>').join('');\n" +
"            } else {\n" +
"                missingSection.classList.add('hidden');\n" +
"            }\n" +
"        }\n" +
"\n" +
"        function formatAuditDate(isoStr) {\n" +
"            if (!isoStr) return '-';\n" +
"            const d = new Date(isoStr);\n" +
"            return (d.getMonth()+1) + '/' + d.getDate() + '/' + d.getFullYear();\n" +
"        }\n" +
"\n" +
"        async function loadBillAuditHistory() {\n" +
"            try {\n" +
"                const resp = await fetch(API_BASE + '/bill-audit/uploads', {\n" +
"                    credentials: 'include',\n" +
"                });\n" +
"                if (!resp.ok) return;\n" +
"                const uploads = await resp.json();\n" +
"                const tbody = document.getElementById('audit-history-table');\n" +
"                if (!uploads || !uploads.length) {\n" +
"                    tbody.innerHTML = '<tr><td colspan=" + '"' + "9" + '"' + " class=" + '"' + "px-4 py-4 text-center text-gray-500" + '"' + ">No audits yet</td></tr>';\n" +
"                    return;\n" +
"                }\n" +
"                tbody.innerHTML = uploads.map(u => '<tr class=" + '"' + "border-b border-dark-600" + '"' + ">' +\n" +
"                    '<td class=" + '"' + "px-4 py-3 text-gray-400 text-xs" + '"' + ">' + new Date(u.created_at).toLocaleString() + '</td>' +\n" +
"                    '<td class=" + '"' + "px-4 py-3 text-gray-300" + '"' + ">' + (u.vendor || 'wing') + '</td>' +\n" +
"                    '<td class=" + '"' + "px-4 py-3 text-gray-300" + '"' + ">' + (u.filename || '-') + '</td>' +\n" +
"                    '<td class=" + '"' + "px-4 py-3 text-gray-400 text-xs" + '"' + ">' + (u.billing_period_start || '?') + ' - ' + (u.billing_period_end || '?') + '</td>' +\n" +
"                    '<td class=" + '"' + "px-4 py-3 text-gray-300" + '"' + ">' + u.total_rows + '</td>' +\n" +
"                    '<td class=" + '"' + "px-4 py-3 text-gray-300" + '"' + ">$' + Number(u.total_amount).toFixed(2) + '</td>' +\n" +
"                    '<td class=" + '"' + "px-4 py-3 ' + (u.overcharge_amount > 0 ? 'text-red-400 font-semibold' : 'text-accent') + '" + '"' + ">$' + Number(u.overcharge_amount || 0).toFixed(2) + '</td>' +\n" +
"                    '<td class=" + '"' + "px-4 py-3 ' + (u.discrepancy_count > 0 ? 'text-red-400 font-semibold' : 'text-accent') + '" + '"' + ">' + u.discrepancy_count + '</td>' +\n" +
"                    '<td class=" + '"' + "px-4 py-3" + '"' + "><button onclick=" + '"' + "viewBillAuditResults(' + u.id + ')" + '"' + " class=" + '"' + "text-xs text-blue-400 hover:text-blue-300 mr-2" + '"' + ">View</button>' +\n" +
"                    '<button onclick=" + '"' + "exportBillAudit(' + u.id + ')" + '"' + " class=" + '"' + "text-xs text-accent hover:text-green-300" + '"' + ">Export</button></td>' +\n" +
"                    '</tr>').join('');\n" +
"            } catch (e) { console.error('loadBillAuditHistory:', e); }\n" +
"        }\n" +
"\n" +
"        async function viewBillAuditResults(uploadId) {\n" +
"            try {\n" +
"                const resp = await fetch(API_BASE + '/bill-audit/results?upload_id=' + uploadId, {\n" +
"                    credentials: 'include',\n" +
"                });\n" +
"                const data = await resp.json();\n" +
"                if (data.error) { showToast(data.error, 'error'); return; }\n" +
"                window._auditUploadId = uploadId;\n" +
"                renderBillAuditResults({\n" +
"                    total_rows: data.upload.total_rows,\n" +
"                    total_amount: data.upload.total_amount,\n" +
"                    total_expected: data.upload.total_expected,\n" +
"                    overcharge_amount: data.upload.overcharge_amount,\n" +
"                    discrepancy_count: data.upload.discrepancy_count,\n" +
"                    discrepancies: data.discrepancies,\n" +
"                    missing_from_bill: [],\n" +
"                    missing_count: 0,\n" +
"                });\n" +
"            } catch (e) { showToast('Error: ' + e, 'error'); }\n" +
"        }\n" +
"\n" +
"        function exportBillAudit(uploadId) {\n" +
"            if (!uploadId) { showToast('No audit to export', 'error'); return; }\n" +
"            window.open(API_BASE + '/bill-audit/export?upload_id=' + uploadId, '_blank');\n" +
"        }\n" +
"\n";

content = content.slice(0, jsStart) + NEW_JS + content.slice(jsEnd);

// ── E. Tab handler call: loadWingHistory() → loadBillAuditHistory() ──
const TAB_OLD = "if (tabName === 'billing') { loadMappings(); loadBillingResellers(); loadInvoiceHistory(); loadWingHistory(); }";
const TAB_NEW = "if (tabName === 'billing') { loadMappings(); loadBillingResellers(); loadInvoiceHistory(); loadBillAuditHistory(); }";
if (!content.includes(TAB_OLD)) { console.error('PATCH FAILED: tab handler line not found'); process.exit(1); }
content = content.replace(TAB_OLD, TAB_NEW);

// Convert back to CRLF
content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch applied successfully.');
