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
        await fetch(`${env.SUPABASE_URL}/rest/v1/billing_ledger?on_conflict=sim_id,vendor,period_start`, {
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

async function handleBillingLedgerRegenerate(request, env, corsHeaders, url) {
    try {
        const vendorParam = url.searchParams.get('vendor');
        const vendors = vendorParam ? [vendorParam] : ['wing_iot', 'atomic', 'helix', 'teltik'];
        const results = [];
        for (const v of vendors) {
            results.push(await regenerateLedgerForVendor(env, v));
        }
        return new Response(JSON.stringify({ ok: true, results }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
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
    const vendor = normalizeVendorName(upload.vendor || 'wing_iot');

    const lines = await supabaseGetAllArray(env, `bill_audit_lines?upload_id=eq.${uploadId}&order=id.asc`) || [];
    if (!lines.length) return { upload_id: uploadId, matched: 0, missing: 0, phantom: 0 };

    const iccids = [...new Set(lines.map(l => l.subscription_iccid).filter(Boolean))];
    const ledgerRows = [];
    const CHUNK = 200;
    for (let i = 0; i < iccids.length; i += CHUNK) {
        const chunk = iccids.slice(i, i + CHUNK);
        const inClause = chunk.map(s => `"${s}"`).join(',');
        const rows = await supabaseGetAllArray(env, `billing_ledger?vendor=eq.${vendor}&iccid=in.(${inClause})&order=period_start.asc`) || [];
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
        });
    }

    for (let i = 0; i < updates.length; i += 500) {
        const batch = updates.slice(i, i + 500);
        await fetch(`${env.SUPABASE_URL}/rest/v1/billing_ledger?on_conflict=id`, {
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

async function handleBillingLedgerReconcile(request, env, corsHeaders, url) {
    try {
        const uploadId = url.searchParams.get('upload_id');
        if (!uploadId) return new Response(JSON.stringify({ error: 'upload_id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        const result = await reconcileLedgerForUpload(env, uploadId);
        return new Response(JSON.stringify({ ok: true, ...result }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
}

async function handleBillingLedgerList(env, corsHeaders, url) {
    try {
        const filters = [];
        const sim_id = url.searchParams.get('sim_id');
        const vendor = url.searchParams.get('vendor');
        const status = url.searchParams.get('status');
        const periodStart = url.searchParams.get('period_start');
        if (sim_id) filters.push(`sim_id=eq.${encodeURIComponent(sim_id)}`);
        if (vendor) filters.push(`vendor=eq.${encodeURIComponent(vendor)}`);
        if (status) filters.push(`status=eq.${encodeURIComponent(status)}`);
        if (periodStart) filters.push(`period_start=eq.${encodeURIComponent(periodStart)}`);
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '500'), 5000);
        const offset = parseInt(url.searchParams.get('offset') || '0');
        const order = 'order=period_start.desc,iccid.asc';
        const path = `billing_ledger?${filters.join('&')}${filters.length ? '&' : ''}${order}&limit=${limit}&offset=${offset}`;
        const rows = await sbGet(env, path);
        return new Response(JSON.stringify(rows || []), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
}

async function handleBillingLedgerSummary(env, corsHeaders, url) {
    try {
        const vendor = url.searchParams.get('vendor');
        const vendorFilter = vendor ? `&vendor=eq.${encodeURIComponent(vendor)}` : '';
        const statuses = ['pending','billed','over','under','missing','phantom','disputed','resolved'];
        const counts = {};
        await Promise.all(statuses.map(async s => {
            const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/billing_ledger?status=eq.${s}${vendorFilter}&select=id&limit=1`, {
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