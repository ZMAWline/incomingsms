// Carrier bill imports, discrepancy audit and billing ledger.
import { parsePositiveInt, badRequest, errorResponse, supabaseJson, LEDGER_VENDORS } from '../request.mjs';
import { sbGet, sbPatch } from '../../shared/supabase-rest.mjs';
import { supabaseGet, supabaseGetAllArray, billingFetch, sbPost } from './database.mjs';
import { loadActiveRates, WING_AGGREGATOR_VENDORS } from './rates.mjs';

const NON_BILLABLE_TERMINAL_STATUSES = new Set(['canceled', 'cancelled', 'error', 'abandoned']);

function parseBillCSV(text, vendor) {
    if (vendor === 'teltik') return parseTeltikCSV(text);
    return parseWingCSV(text);
}

function parseWingCSV(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) throw new Error('CSV has no data rows');
    const headers = lines[0].split(',').map(h => h.trim());
    return lines.slice(1).map(line => {
        const values = splitCSVLine(line);
        const row = {};
        headers.forEach((h, i) => { row[h] = (values[i] || '').trim(); });
        return row;
    });
}

function parseUSDateMDY(s) {
    const parts = s.split('/').map(n => parseInt(n, 10));
    if (parts.length !== 3 || parts.some(isNaN)) return null;
    return new Date(Date.UTC(parts[2], parts[0] - 1, parts[1]));
}

function unquote(s) {
    if (!s) return '';
    s = s.trim();
    if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
    return s.trim();
}

function parseTeltikCSV(text) {
    const allLines = text.split('\n').map(l => l.replace(/\r$/, ''));
    let invoiceNo = null, periodStart = null, periodEnd = null;
    for (let i = 0; i < Math.min(40, allLines.length); i++) {
        const ln = allLines[i];
        const mi = ln.match(/Invoice No\.?\s*([A-Za-z0-9-]+)/i);
        if (mi && !invoiceNo) invoiceNo = mi[1];
        const mb = ln.match(/Period Beginning\.?\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
        if (mb && !periodStart) periodStart = parseUSDateMDY(mb[1]);
        const me = ln.match(/Period Ending\.?\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
        if (me && !periodEnd) periodEnd = parseUSDateMDY(me[1]);
    }

    let headerIdx = -1;
    for (let i = 0; i < allLines.length; i++) {
        const ln = allLines[i].toUpperCase();
        if (ln.includes('LINE NUMBER') && ln.includes('SIM NUMBER') && ln.includes('PLAN NAME')) { headerIdx = i; break; }
    }
    if (headerIdx === -1) throw new Error('Teltik CSV: header row (LINE NUMBER, SIM NUMBER, PLAN NAME) not found');

    const headers = splitCSVLine(allLines[headerIdx]).map(h => unquote(h));
    const idxOf = (name) => headers.findIndex(h => h.toUpperCase() === name.toUpperCase());
    const iSim = idxOf('SIM NUMBER');
    const iLine = idxOf('LINE NUMBER');
    const iPlan = idxOf('PLAN NAME');
    const iPlanCharges = idxOf('PLAN CHARGES');
    if (iSim < 0 || iLine < 0 || iPlan < 0 || iPlanCharges < 0) {
        throw new Error('Teltik CSV: required header columns missing');
    }

    const fromIso = periodStart ? periodStart.toISOString() : '';
    const toIso = periodEnd ? periodEnd.toISOString() : '';
    const out = [];
    for (let i = headerIdx + 1; i < allLines.length; i++) {
        const raw = allLines[i];
        if (!raw || !raw.trim()) continue;
        const values = splitCSVLine(raw);
        const sim = unquote(values[iSim] || '').replace(/^'/, '').trim();
        const lineNum = unquote(values[iLine] || '').trim();
        if (!sim || !lineNum) continue;
        const plan = unquote(values[iPlan] || '').trim();
        const planChargesStr = unquote(values[iPlanCharges] || '0').replace(/[$,\s]/g, '');
        const price = parseFloat(planChargesStr) || 0;
        const row = {
            'Id': lineNum,
            'Item Type': 'Plan',
            'Description': plan,
            'From Date': fromIso,
            'To Date': toIso,
            'Subscription Name': plan,
            'Subscription Iccid': sim,
            'Subscription Identifier': lineNum,
            'Bypassed Plan ID': '',
            'Carrier': 'T-Mobile',
            'Price': String(price),
        };
        if (out.length === 0 && invoiceNo) row._invoice_no = invoiceNo;
        out.push(row);
    }
    if (!out.length) throw new Error('Teltik CSV: no data rows after header');
    if (invoiceNo && out[0]) out[0]._invoice_no = invoiceNo;
    return out;
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

// Find the most recent transition into a non-billable terminal status for this SIM.
// Returns ISO timestamp or null.
function findCancelTimestamp(history) {
    if (!history || !history.length) return null;
    const cancels = history.filter(h => NON_BILLABLE_TERMINAL_STATUSES.has((h.new_status || '').toLowerCase()));
    if (!cancels.length) return null;
    cancels.sort((a, b) => new Date(b.changed_at) - new Date(a.changed_at));
    return cancels[0].changed_at;
}

// ── Billing Ledger ──────────────────────────────────────────────────────────
// Tracks expected vendor charges per SIM per billing cycle, then reconciles
// against bill_audit_lines on upload. Surfaces over/under/missing/phantom
// charges across time so we can catch double-billing and missed charges.

function cycleAnchorForVendor(vendor) {
    // Teltik bills 16th→15th. AT&T (wing_iot/atomic/helix) bills 5th→4th.
    return vendor === 'teltik' ? 16 : 5;
}

function cycleBoundsContaining(dateInput, anchorDay) {
    const d = new Date(dateInput);
    const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();
    let startY, startM;
    if (day >= anchorDay) { startY = y; startM = m; }
    else { startY = m === 0 ? y - 1 : y; startM = m === 0 ? 11 : m - 1; }
    const start = new Date(Date.UTC(startY, startM, anchorDay));
    const endY = startM === 11 ? startY + 1 : startY;
    const endM = startM === 11 ? 0 : startM + 1;
    const end = new Date(Date.UTC(endY, endM, anchorDay - 1));
    return { start, end };
}

function nextCycle(cycle, anchorDay) {
    const newStart = new Date(cycle.end);
    newStart.setUTCDate(newStart.getUTCDate() + 1);
    return cycleBoundsContaining(newStart, anchorDay);
}

function isoDate(d) { return d.toISOString().split('T')[0]; }

function daysBetween(start, end) {
    return Math.round((end - start) / 86400000) + 1;
}

// Normalize legacy 'wing' → 'wing_iot' so old uploads reconcile against the right vendor.
function normalizeVendorName(v) {
    if (!v) return v;
    if (v === 'wing') return 'wing_iot';
    return v;
}

async function regenerateLedgerForVendor(env, vendor, options) {
    options = options || {};
    const today = options.today ? new Date(options.today) : new Date();
    const v = normalizeVendorName(vendor);
    const anchor = cycleAnchorForVendor(v);
    const ratesByVendor = await loadActiveRates(env);
    const rateEntry = ratesByVendor[v] || null;

    const sims = await supabaseGetAllArray(env, `sims?vendor=eq.${v}&select=id,iccid,activated_at,status`);
    if (!sims || !sims.length) return { vendor: v, sims: 0, rows: 0 };

    // Bulk-fetch cancel histories for terminal SIMs only
    const terminalSims = sims.filter(s => NON_BILLABLE_TERMINAL_STATUSES.has((s.status || '').toLowerCase()));
    const historyBySimId = {};
    if (terminalSims.length) {
        const ids = terminalSims.map(s => s.id);
        for (let i = 0; i < ids.length; i += 200) {
            const chunk = ids.slice(i, i + 200);
            const hist = await supabaseGetAllArray(env, `sim_status_history?sim_id=in.(${chunk.join(',')})&order=changed_at.desc`) || [];
            hist.forEach(h => {
                if (!historyBySimId[h.sim_id]) historyBySimId[h.sim_id] = [];
                historyBySimId[h.sim_id].push(h);
            });
        }
    }

    const allRows = [];
    for (const sim of sims) {
        if (!sim.activated_at) continue;
        const activatedAt = new Date(sim.activated_at);
        if (activatedAt > today) continue;

        let cancelDate = null;
        if (NON_BILLABLE_TERMINAL_STATUSES.has((sim.status || '').toLowerCase())) {
            const tsStr = findCancelTimestamp(historyBySimId[sim.id] || []);
            cancelDate = tsStr ? new Date(tsStr) : null;
        }

        const endLimit = cancelDate || today;
        let cycle = cycleBoundsContaining(activatedAt, anchor);
        let safetyN = 0;
        while (cycle.start <= endLimit && safetyN++ < 240) {
            const simStartedThisCycle = activatedAt >= cycle.start && activatedAt <= cycle.end;
            const cycleStartsAfterCancel = cancelDate && cycle.start > cancelDate;
            if (cycleStartsAfterCancel) break;

            let expected = null, basis = 'unknown_rate';
            if (rateEntry) {
                if (v === 'teltik' && simStartedThisCycle) {
                    const daysActive = daysBetween(activatedAt, cycle.end);
                    const daysCycle = daysBetween(cycle.start, cycle.end);
                    expected = Math.round((rateEntry.rate * daysActive / daysCycle) * 10000) / 10000;
                    basis = 'prorated_activation';
                } else {
                    expected = rateEntry.rate;
                    basis = 'full_cycle';
                }
            }

            allRows.push({
                sim_id: sim.id,
                iccid: sim.iccid,
                vendor: v,
                plan_name: rateEntry ? rateEntry.plan_name : null,
                period_start: isoDate(cycle.start),
                period_end: isoDate(cycle.end),
                expected_amount: expected,
                expected_basis: basis,
            });

            if (cycle.start > today) break;
            cycle = nextCycle(cycle, anchor);
        }
    }

    // Bulk upsert. Don't include status/billed_amount/bill_audit_line_id/notes —
    // those are reconciliation-managed; preserved on update by omitting them.
    const CHUNK = 500;
    for (let i = 0; i < allRows.length; i += CHUNK) {
        const batch = allRows.slice(i, i + CHUNK);
        await billingFetch(env, `${env.SUPABASE_URL}/rest/v1/billing_ledger?on_conflict=sim_id,vendor,period_start`, {
            method: 'POST',
            headers: {
                'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
                'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
                'Content-Type': 'application/json',
                'Prefer': 'resolution=merge-duplicates,return=minimal',
            },
            body: JSON.stringify(batch),
        });
    }

    return { vendor: v, sims: sims.length, rows: allRows.length };
}

export async function handleBillingLedgerRegenerate(request, env, corsHeaders, url) {
    try {
        const vendorParam = url.searchParams.get('vendor');
        if (vendorParam && !LEDGER_VENDORS.includes(normalizeVendorName(vendorParam))) {
            return badRequest(corsHeaders, 'Invalid vendor. Valid: ' + LEDGER_VENDORS.join(', '));
        }
        const vendors = vendorParam ? [vendorParam] : LEDGER_VENDORS;
        const results = [];
        for (const v of vendors) {
            results.push(await regenerateLedgerForVendor(env, v));
        }
        return new Response(JSON.stringify({ ok: true, results }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (e) {
        return errorResponse(e, corsHeaders);
    }
}

// Reconcile a bill upload against the ledger.
// For each bill_audit_lines row of this upload:
//   - Find matching ledger row by (iccid, vendor, period containing from_date)
//   - Set ledger.billed_amount, bill_audit_line_id
//   - Status: billed (within $0.01), over (billed > expected), under (billed < expected)
// After matching, mark unmatched ledger rows in the bill's covered period as 'missing'.
async function reconcileLedgerForUpload(env, uploadId) {
    const uploadResp = await sbGet(env, `bill_audit_uploads?id=eq.${encodeURIComponent(uploadId)}&limit=1`);
    if (!uploadResp || !uploadResp.length) throw new Error('upload not found');
    const upload = uploadResp[0];
    const invoiceNo = upload.invoice_no || (upload.filename || '').replace(/\.[^.]+$/, '') || null;
    const vendor = normalizeVendorName(upload.vendor || 'wing_iot');
    const ledgerVendorFilter = vendor === 'wing_aggregator'
        ? `vendor=in.(${WING_AGGREGATOR_VENDORS.join(',')})`
        : `vendor=eq.${vendor}`;

    const lines = await supabaseGetAllArray(env, `bill_audit_lines?upload_id=eq.${encodeURIComponent(uploadId)}&order=id.asc`) || [];
    if (!lines.length) return { upload_id: uploadId, matched: 0, missing: 0, phantom: 0 };

    const iccids = [...new Set(lines.map(l => l.subscription_iccid).filter(Boolean))];
    const ledgerRows = [];
    const CHUNK = 200;
    for (let i = 0; i < iccids.length; i += CHUNK) {
        const chunk = iccids.slice(i, i + CHUNK);
        const inClause = chunk.map(s => `"${s}"`).join(',');
        const rows = await supabaseGetAllArray(env, `billing_ledger?${ledgerVendorFilter}&iccid=in.(${inClause})&order=period_start.asc`) || [];
        ledgerRows.push(...rows);
    }
    const ledgerByIccid = {};
    ledgerRows.forEach(r => {
        if (!ledgerByIccid[r.iccid]) ledgerByIccid[r.iccid] = [];
        ledgerByIccid[r.iccid].push(r);
    });

    const updates = [];
    const matchedLedgerIds = new Set();
    let phantomCount = 0;

    for (const line of lines) {
        if (!line.subscription_iccid || !line.from_date) continue;
        const fromDate = new Date(line.from_date);
        const candidates = ledgerByIccid[line.subscription_iccid] || [];
        const match = candidates.find(r => {
            const ps = new Date(r.period_start), pe = new Date(r.period_end);
            return fromDate >= ps && fromDate <= pe;
        });

        if (!match) { phantomCount++; continue; }

        matchedLedgerIds.add(match.id);
        const billed = parseFloat(line.price || '0');
        const expected = match.expected_amount != null ? parseFloat(match.expected_amount) : null;
        let status = 'billed';
        if (expected != null) {
            const diff = billed - expected;
            if (Math.abs(diff) <= 0.01) status = 'billed';
            else if (diff > 0) status = 'over';
            else status = 'under';
        }

        updates.push({
            id: match.id,
            sim_id: match.sim_id,
            iccid: match.iccid,
            vendor: match.vendor,
            plan_name: match.plan_name,
            period_start: match.period_start,
            period_end: match.period_end,
            expected_amount: match.expected_amount,
            expected_basis: match.expected_basis,
            billed_amount: billed,
            bill_audit_line_id: line.id,
            status,
            invoice_no: invoiceNo,
        });
    }

    for (let i = 0; i < updates.length; i += 500) {
        const batch = updates.slice(i, i + 500);
        await billingFetch(env, `${env.SUPABASE_URL}/rest/v1/billing_ledger?on_conflict=id`, {
            method: 'POST',
            headers: {
                'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
                'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
                'Content-Type': 'application/json',
                'Prefer': 'resolution=merge-duplicates,return=minimal',
            },
            body: JSON.stringify(batch),
        });
    }

    let missingCount = 0;
    if (upload.billing_period_start && upload.billing_period_end) {
        const periodCovered = ledgerRows.filter(r =>
            !matchedLedgerIds.has(r.id) &&
            r.status !== 'disputed' && r.status !== 'resolved' &&
            new Date(r.period_start) >= new Date(upload.billing_period_start) &&
            new Date(r.period_end) <= new Date(upload.billing_period_end)
        );
        if (periodCovered.length) {
            const ids = periodCovered.map(r => r.id);
            for (let i = 0; i < ids.length; i += 200) {
                const chunk = ids.slice(i, i + 200);
                await sbPatch(env, `billing_ledger?id=in.(${chunk.join(',')})`, { status: 'missing' });
            }
            missingCount = ids.length;
        }
    }

    return { upload_id: uploadId, matched: updates.length, missing: missingCount, phantom: phantomCount };
}

export async function handleBillingLedgerReconcile(request, env, corsHeaders, url) {
    try {
        const uploadId = url.searchParams.get('upload_id');
        if (!uploadId) return new Response(JSON.stringify({ error: 'upload_id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        const result = await reconcileLedgerForUpload(env, uploadId);
        return new Response(JSON.stringify({ ok: true, ...result }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (e) {
        return errorResponse(e, corsHeaders);
    }
}

export async function handleBillingLedgerList(env, corsHeaders, url) {
    try {
        const filters = [];
        const sim_id = url.searchParams.get('sim_id');
        const iccid = (url.searchParams.get('iccid') || '').trim();
        const vendor = url.searchParams.get('vendor');
        const status = url.searchParams.get('status');
        const periodMonth = url.searchParams.get('period_month'); // YYYY-MM
        if (sim_id) {
            if (!parsePositiveInt(sim_id)) return badRequest(corsHeaders, 'sim_id must be a positive whole number');
            filters.push(`sim_id=eq.${sim_id}`);
        }
        if (iccid) filters.push(`iccid=ilike.*${encodeURIComponent(iccid)}*`);
        if (vendor) filters.push(`vendor=eq.${encodeURIComponent(vendor)}`);
        if (status) filters.push(`status=eq.${encodeURIComponent(status)}`);
        if (periodMonth && /^\d{4}-\d{2}$/.test(periodMonth)) {
            const [y, m] = periodMonth.split('-').map(Number);
            const monthStart = `${y}-${String(m).padStart(2, '0')}-01`;
            const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
            const monthEnd = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
            filters.push(`period_start=gte.${monthStart}`);
            filters.push(`period_start=lte.${monthEnd}`);
        }
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '100'), 1000);
        const offset = parseInt(url.searchParams.get('offset') || '0');
        const order = 'order=period_start.desc,iccid.asc';
        const path = `billing_ledger?${filters.join('&')}${filters.length ? '&' : ''}${order}&limit=${limit}&offset=${offset}`;

        const resp = await billingFetch(env, `${env.SUPABASE_URL}/rest/v1/${path}`, {
            headers: {
                'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
                'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
                'Prefer': 'count=exact',
            },
        });
        const rows = await supabaseJson(resp);
        const cr = resp.headers.get('content-range') || '*/0';
        const total = parseInt(cr.split('/')[1] || '0');
        return new Response(JSON.stringify({ rows: rows || [], total, limit, offset }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (e) {
        return errorResponse(e, corsHeaders);
    }
}

export async function handleBillingLedgerMonths(env, corsHeaders) {
    try {
        const resp = await billingFetch(env, `${env.SUPABASE_URL}/rest/v1/rpc/get_ledger_months`, {
            method: 'POST',
            headers: {
                'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
                'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
                'Content-Type': 'application/json',
            },
            body: '{}',
        });
        const rows = await supabaseJson(resp);
        const months = (rows || []).map(r => r.month).filter(Boolean);
        return new Response(JSON.stringify({ months }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (e) {
        return errorResponse(e, corsHeaders);
    }
}

export async function handleBillingLedgerSummary(env, corsHeaders, url) {
    try {
        const vendor = url.searchParams.get('vendor');
        const vendorFilter = vendor ? `&vendor=eq.${encodeURIComponent(vendor)}` : '';
        const statuses = ['pending','billed','over','under','missing','phantom','disputed','resolved'];
        const counts = {};
        await Promise.all(statuses.map(async s => {
            const resp = await billingFetch(env, `${env.SUPABASE_URL}/rest/v1/billing_ledger?status=eq.${s}${vendorFilter}&select=id&limit=1`, {
                headers: {
                    'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
                    'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
                    'Prefer': 'count=exact',
                    'Range-Unit': 'items',
                    'Range': '0-0',
                },
            });
            const cr = resp.headers.get('content-range') || '*/0';
            counts[s] = parseInt(cr.split('/')[1] || '0');
        }));
        return new Response(JSON.stringify({ counts }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
}

// Time-aware audit + Teltik activation proration.
function auditOneLine({ row, sim, history, fromDate, vendor, allPlanRates }) {
    const price = parseFloat(row['Price'] || '0');
    const planId = (row['Bypassed Plan ID'] || '').trim() || null;
    const description = (row['Description'] || '').trim();

    function pickRate(predicate) {
        const candidates = (allPlanRates || []).filter(predicate);
        if (!candidates.length) return null;
        if (!fromDate) return candidates[0];
        const match = candidates.find(r => {
            const ef = new Date(r.effective_from);
            const et = r.effective_to ? new Date(r.effective_to) : null;
            return ef <= fromDate && (!et || et >= fromDate);
        });
        return match || null;
    }

    let rateEntry = null;
    let resolvedVendor = vendor;

    if (vendor === 'wing_aggregator') {
        const key = description.toLowerCase().trim();
        const matched = key ? pickRate(r => (r.plan_name || '').toLowerCase().trim() === key) : null;
        if (matched) {
            rateEntry = { rate: parseFloat(matched.rate), plan_name: matched.plan_name };
            resolvedVendor = matched.vendor;
        } else {
            const dateLabel = fromDate ? fromDate.toISOString().split('T')[0] : 'today';
            return {
                discrepancyType: 'unknown_plan',
                discrepancyDetail: `Plan "${description || planId || '(blank)'}" has no plan_rates row active on ${dateLabel}`,
                expectedPrice: 0,
                resolvedVendor: null,
            };
        }
    } else {
        const matched = pickRate(r => r.vendor === vendor);
        if (matched) rateEntry = { rate: parseFloat(matched.rate), plan_name: matched.plan_name };
    }

    let knownRate = rateEntry ? rateEntry.rate : null;
    let prorated = false;

    if (!sim) {
        return { discrepancyType: 'unknown_iccid', discrepancyDetail: `ICCID ${row['Subscription Iccid'] || '(blank)'} not found in our system`, expectedPrice: 0, resolvedVendor };
    }

    if (NON_BILLABLE_TERMINAL_STATUSES.has((sim.status || '').toLowerCase())) {
        const canceledAt = findCancelTimestamp(history);
        if (canceledAt && fromDate && new Date(canceledAt) < fromDate) {
            const dt = new Date(canceledAt).toISOString().split('T')[0];
            return { discrepancyType: 'canceled_before_period', discrepancyDetail: `SIM was ${sim.status} as of ${dt}, before bill period start`, expectedPrice: 0, resolvedVendor };
        }
        if (!canceledAt) {
            return { discrepancyType: 'canceled_before_period', discrepancyDetail: `SIM is ${sim.status} (no cancel-date record); flag for review`, expectedPrice: 0, resolvedVendor };
        }
    }

    // Teltik prorates plan charges on activation only (vendor-billing-cycles memory).
    // If the SIM activated mid-bill-period, expected = rate × daysActive / cycleDays.
    if (knownRate != null && resolvedVendor === 'teltik' && sim.activated_at && fromDate && row['To Date']) {
        const activatedAt = new Date(sim.activated_at);
        const periodEnd = new Date(row['To Date']);
        if (activatedAt > fromDate && activatedAt <= periodEnd) {
            const daysActive = Math.max(1, Math.round((periodEnd - activatedAt) / 86400000) + 1);
            const daysCycle = Math.max(1, Math.round((periodEnd - fromDate) / 86400000) + 1);
            knownRate = Math.round((knownRate * daysActive / daysCycle) * 100) / 100;
            prorated = true;
        }
    }

    if (knownRate != null && Math.abs(price - knownRate) > 0.01) {
        const planLabel = rateEntry.plan_name || planId || resolvedVendor;
        const proLabel = prorated ? ' (prorated)' : '';
        return { discrepancyType: 'rate_mismatch', discrepancyDetail: `${planLabel}${proLabel}: expected $${knownRate.toFixed(2)} but charged $${price.toFixed(2)}`, expectedPrice: knownRate, resolvedVendor };
    }

    return { discrepancyType: null, discrepancyDetail: null, expectedPrice: knownRate != null ? knownRate : price, resolvedVendor };
}

export async function handleBillAuditUpload(request, env, corsHeaders) {
    try {
        const formData = await request.formData();
        const file = formData.get('file');
        if (!file) return new Response(JSON.stringify({ error: 'No file uploaded' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        const csvText = await file.text();
        const filename = file.name || 'bill.csv';
        const vendor = (new URL(request.url)).searchParams.get('vendor') || 'wing';

        let rows;
        try {
            rows = parseBillCSV(csvText, vendor);
        } catch (parseErr) {
            return new Response(JSON.stringify({ error: String(parseErr.message || parseErr) }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        if (!rows.length) return new Response(JSON.stringify({ error: 'CSV has no data rows' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        const parsedInvoiceNo = rows[0] && rows[0]._invoice_no ? rows[0]._invoice_no : null;

        const [upload] = await sbPost(env, 'bill_audit_uploads', { filename, vendor, total_rows: rows.length, status: 'processing', invoice_no: parsedInvoiceNo });
        const uploadId = upload.id;

        const allPlanRates = await sbGet(env, 'plan_rates?order=effective_from.desc') || [];
        const allSims = await supabaseGetAllArray(env, 'sims?select=id,iccid,status,vendor,activated_at') || [];
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
            const idArr = [...simIds];
            for (let i = 0; i < idArr.length; i += 200) {
                const chunk = idArr.slice(i, i + 200);
                const part = await supabaseGetAllArray(env, `sim_status_history?sim_id=in.(${chunk.join(',')})&order=changed_at.desc`) || [];
                allHistory.push(...part);
            }
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

            const audit = auditOneLine({ row, sim, history, fromDate, vendor, allPlanRates });

            billedIccids.add(iccid);
            lineRecords.push({
                upload_id: uploadId,
                vendor: audit.resolvedVendor || vendor,
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
                            b.discrepancy_detail = `Overlapping period with line ${a.wing_id || a.subscription_iccid}`;
                            b.expected_price = 0;
                        }
                    }
                }
            }
        }

        const targetVendors = vendor === 'wing_aggregator'
            ? new Set(WING_AGGREGATOR_VENDORS)
            : new Set([vendor]);
        const activeSims = (allSims || []).filter(s =>
            !NON_BILLABLE_TERMINAL_STATUSES.has((s.status || '').toLowerCase()) &&
            s.status !== 'provisioning' &&
            targetVendors.has(s.vendor)
        );
        const missingFromBill = activeSims.filter(s => !billedIccids.has(s.iccid));

        for (let i = 0; i < lineRecords.length; i += 500) {
            const batch = lineRecords.slice(i, i + 500);
            await billingFetch(env, `${env.SUPABASE_URL}/rest/v1/bill_audit_lines`, {
                method: 'POST',
                headers: {
                    'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
                    'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
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

        await sbPatch(env, `bill_audit_uploads?id=eq.${uploadId}`, {
            status: 'complete',
            total_amount: totalAmount,
            total_expected: totalExpected,
            overcharge_amount: overchargeAmount,
            discrepancy_count: discrepancyCount,
            billing_period_start: dates[0] ? dates[0].split('T')[0] : null,
            billing_period_end: endDates.length ? endDates[endDates.length - 1].split('T')[0] : null,
        });

        // Auto-update ledger for this vendor (or all 3 AT&T vendors when aggregator) + reconcile this upload
        let ledgerResult = null;
        try {
            if (vendor === 'wing_aggregator') {
                for (const v of WING_AGGREGATOR_VENDORS) await regenerateLedgerForVendor(env, v);
            } else {
                await regenerateLedgerForVendor(env, vendor);
            }
            ledgerResult = await reconcileLedgerForUpload(env, uploadId);
        } catch (recErr) {
            console.error('Ledger reconciliation error:', recErr);
            ledgerResult = { error: String(recErr) };
        }

        return new Response(JSON.stringify({
            upload_id: uploadId,
            ledger: ledgerResult,
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

export async function handleBillAuditResults(env, corsHeaders, url) {
    try {
        const uploadId = url.searchParams.get('upload_id');
        if (!uploadId) return new Response(JSON.stringify({ error: 'upload_id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

        const [uploads, lines] = await Promise.all([
            sbGet(env, `bill_audit_uploads?id=eq.${encodeURIComponent(uploadId)}&limit=1`),
            sbGet(env, `bill_audit_lines?upload_id=eq.${encodeURIComponent(uploadId)}&order=id.asc&limit=10000`),
        ]);

        const upload = Array.isArray(uploads) ? uploads[0] : null;
        if (!upload) return new Response(JSON.stringify({ error: 'Upload not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

        return new Response(JSON.stringify({
            upload,
            lines: lines || [],
            discrepancies: (lines || []).filter(l => l.discrepancy_type),
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (e) {
        return errorResponse(e, corsHeaders);
    }
}

export async function handleBillAuditUploads(env, corsHeaders) {
    try {
        const data = await sbGet(env, 'bill_audit_uploads?select=id,vendor,filename,invoice_no,billing_period_start,billing_period_end,total_rows,total_amount,total_expected,overcharge_amount,discrepancy_count,status,created_at&order=created_at.desc&limit=50');
        return new Response(JSON.stringify(data || []), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (e) {
        return errorResponse(e, corsHeaders);
    }
}

// Delete an audit upload + its lines + reset any ledger rows that were tied to it.
export async function handleBillAuditDelete(env, corsHeaders, url) {
    try {
        const id = url.searchParams.get('id');
        if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

        const lines = await supabaseGetAllArray(env, `bill_audit_lines?upload_id=eq.${encodeURIComponent(id)}&select=id`) || [];
        if (lines.length) {
            const lineIds = lines.map(l => l.id);
            for (let i = 0; i < lineIds.length; i += 200) {
                const chunk = lineIds.slice(i, i + 200);
                await sbPatch(env, `billing_ledger?bill_audit_line_id=in.(${chunk.join(',')})`, {
                    bill_audit_line_id: null,
                    billed_amount: null,
                    invoice_no: null,
                    status: 'pending',
                });
            }
        }

        await billingFetch(env, `${env.SUPABASE_URL}/rest/v1/bill_audit_lines?upload_id=eq.${encodeURIComponent(id)}`, {
            method: 'DELETE',
            headers: {
                'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
                'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
                'Prefer': 'return=minimal',
            },
        });

        const delResp = await billingFetch(env, `${env.SUPABASE_URL}/rest/v1/bill_audit_uploads?id=eq.${encodeURIComponent(id)}`, {
            method: 'DELETE',
            headers: {
                'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
                'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
                'Prefer': 'return=minimal',
            },
        });
        if (!delResp.ok) return new Response(JSON.stringify({ error: 'delete failed' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

        return new Response(JSON.stringify({ ok: true, lines_deleted: lines.length, ledger_reset: lines.length }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (e) {
        return errorResponse(e, corsHeaders);
    }
}

export async function handleBillAuditExport(env, corsHeaders, url) {
    try {
        const uploadId = url.searchParams.get('upload_id');
        if (!uploadId) return new Response('upload_id required', { status: 400 });

        const [uploads, lines] = await Promise.all([
            sbGet(env, `bill_audit_uploads?id=eq.${encodeURIComponent(uploadId)}&limit=1`),
            sbGet(env, `bill_audit_lines?upload_id=eq.${encodeURIComponent(uploadId)}&order=id.asc&limit=10000`),
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
                `"${(l.description || '').replace(/"/g, '""')}"`,
                l.bypassed_plan_id || '',
                l.carrier || '',
                l.from_date ? new Date(l.from_date).toLocaleDateString('en-US') : '',
                l.to_date ? new Date(l.to_date).toLocaleDateString('en-US') : '',
                (l.price || 0).toFixed(2),
                (l.expected_price || 0).toFixed(2),
                overcharge.toFixed(2),
                l.sim_status || 'N/A',
                auditResult,
                `"${(l.discrepancy_detail || '').replace(/"/g, '""')}"`,
            ].join(',');
        });

        const totalBilled = (lines || []).reduce((s, l) => s + (l.price || 0), 0);
        const totalExpected = (lines || []).reduce((s, l) => s + (l.expected_price || 0), 0);
        const totalOvercharge = Math.max(0, totalBilled - totalExpected);
        csvRows.push('');
        csvRows.push(`,,,,,,,${totalBilled.toFixed(2)},${totalExpected.toFixed(2)},${totalOvercharge.toFixed(2)},,"TOTALS",`);

        const csv = csvHeaders + '\n' + csvRows.join('\n');
        const invoiceName = (upload.filename || '').replace(/\.[^.]+$/, '') || `upload-${uploadId}`;
        const exportFilename = `${invoiceName} - Audit.csv`;

        return new Response(csv, {
            headers: {
                ...corsHeaders,
                'Content-Type': 'text/csv',
                'Content-Disposition': `attachment; filename="${exportFilename}"`,
            },
        });
    } catch (e) {
        return errorResponse(e, corsHeaders);
    }
}

// One-time: re-evaluate discrepancies for existing bill_audit_lines using current logic.
// POST /api/bill-audit/recompute             — recomputes ALL uploads
// POST /api/bill-audit/recompute?upload_id=X — recomputes one upload
export async function handleBillAuditRecompute(env, corsHeaders, url) {
    try {
        const filterUploadId = url.searchParams.get('upload_id');
        const uploadFilter = filterUploadId ? `?id=eq.${encodeURIComponent(filterUploadId)}` : '?order=id.asc&limit=200';
        const uploads = await sbGet(env, `bill_audit_uploads${uploadFilter}`);
        if (!uploads || !uploads.length) {
            return new Response(JSON.stringify({ ok: true, message: 'No uploads to recompute', uploads_processed: 0 }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        const allPlanRates = await sbGet(env, 'plan_rates?order=effective_from.desc') || [];
        const allSims = await supabaseGetAllArray(env, 'sims?select=id,iccid,status,vendor,activated_at') || [];
        const simsByIccid = {};
        (allSims || []).forEach(s => { simsByIccid[s.iccid] = s; });

        const summary = [];

        for (const upload of uploads) {
            const lines = await supabaseGetAllArray(env, `bill_audit_lines?upload_id=eq.${upload.id}&order=id.asc`) || [];
            if (!lines.length) { summary.push({ upload_id: upload.id, lines: 0, skipped: true }); continue; }

            const simIds = new Set();
            lines.forEach(l => {
                const sim = l.subscription_iccid ? simsByIccid[l.subscription_iccid] : null;
                if (sim && NON_BILLABLE_TERMINAL_STATUSES.has((sim.status || '').toLowerCase())) simIds.add(sim.id);
            });
            let history = [];
            if (simIds.size > 0) {
                const idArr = [...simIds];
                for (let i = 0; i < idArr.length; i += 200) {
                    const chunk = idArr.slice(i, i + 200);
                    const part = await supabaseGetAllArray(env, `sim_status_history?sim_id=in.(${chunk.join(',')})&order=changed_at.desc`) || [];
                    history.push(...part);
                }
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
                    'Description': l.description || '',
                    'To Date': l.to_date || '',
                    'Price': String(l.price || 0),
                };
                const audit = auditOneLine({ row, sim, history: sim ? (historyBySimId[sim.id] || []) : [], fromDate, vendor: upload.vendor, allPlanRates });
                return {
                    ...l,
                    sim_id: sim?.id || null,
                    sim_status: sim?.status || null,
                    vendor: audit.resolvedVendor || l.vendor,
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
                                b.discrepancy_detail = `Overlapping period with line ${a.wing_id || a.subscription_iccid}`;
                                b.expected_price = 0;
                            }
                        }
                    }
                }
            }

            // Bulk upsert in chunks (avoids CF subrequest cap and PostgREST 1000-row read cap)
            const upsertRows = updated.map(r => ({
                id: r.id,
                upload_id: r.upload_id,
                vendor: r.vendor,
                subscription_iccid: r.subscription_iccid,
                bypassed_plan_id: r.bypassed_plan_id,
                price: r.price,
                from_date: r.from_date,
                to_date: r.to_date,
                wing_id: r.wing_id,
                item_type: r.item_type,
                description: r.description,
                subscription_name: r.subscription_name,
                subscription_identifier: r.subscription_identifier,
                carrier: r.carrier,
                sim_id: r.sim_id,
                sim_status: r.sim_status,
                discrepancy_type: r.discrepancy_type,
                discrepancy_detail: r.discrepancy_detail,
                expected_price: r.expected_price,
            }));
            for (let i = 0; i < upsertRows.length; i += 500) {
                const batch = upsertRows.slice(i, i + 500);
                await billingFetch(env, `${env.SUPABASE_URL}/rest/v1/bill_audit_lines?on_conflict=id`, {
                    method: 'POST',
                    headers: {
                        'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
                        'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
                        'Content-Type': 'application/json',
                        'Prefer': 'resolution=merge-duplicates,return=minimal',
                    },
                    body: JSON.stringify(batch),
                });
            }

            const totalAmount = updated.reduce((s, r) => s + (r.price || 0), 0);
            const totalExpected = updated.reduce((s, r) => s + (r.expected_price || 0), 0);
            const overcharge = Math.max(0, Math.round((totalAmount - totalExpected) * 100) / 100);
            const discCount = updated.filter(r => r.discrepancy_type).length;
            await sbPatch(env, `bill_audit_uploads?id=eq.${upload.id}`, {
                total_amount: totalAmount,
                total_expected: totalExpected,
                overcharge_amount: overcharge,
                discrepancy_count: discCount,
            });

            summary.push({ upload_id: upload.id, filename: upload.filename, lines: updated.length, discrepancies: discCount, overcharge });
        }

        return new Response(JSON.stringify({ ok: true, uploads_processed: summary.length, summary }, null, 2), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (e) {
        return errorResponse(e, corsHeaders);
    }
}
