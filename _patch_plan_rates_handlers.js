// ── Billing Audit (vendor-agnostic, non-prorated) ───────────────────────────
// Plan rates live in the plan_rates table (managed via Plan Rates UI).
// Lookup is by vendor — each vendor has exactly one active plan at a time.

async function loadActiveRates(env, atDate) {
    const at = atDate ? new Date(atDate).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];
    const rows = await sbGet(env, `plan_rates?or=(effective_to.is.null,effective_to.gte.${at})&effective_from=lte.${at}&order=effective_from.desc`);
    const out = {};
    (rows || []).forEach(r => {
        if (!out[r.vendor]) out[r.vendor] = { rate: parseFloat(r.rate), plan_name: r.plan_name };
    });
    return out;
}

async function handlePlanRatesList(env, corsHeaders) {
    const rows = await sbGet(env, 'plan_rates?order=vendor.asc,plan_name.asc,effective_from.desc');
    return new Response(JSON.stringify(rows || []), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

async function handlePlanRatesCreate(request, env, corsHeaders) {
    try {
        const body = await request.json();
        const vendor = (body.vendor || '').trim();
        const plan_name = (body.plan_name || '').trim();
        const rate = parseFloat(body.rate);
        const effective_from = body.effective_from || new Date().toISOString().split('T')[0];
        const notes = body.notes || null;
        if (!vendor || !plan_name || !(rate >= 0)) {
            return new Response(JSON.stringify({ error: 'vendor, plan_name, and non-negative rate required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        const existing = await sbGet(env, `plan_rates?vendor=eq.${encodeURIComponent(vendor)}&plan_name=eq.${encodeURIComponent(plan_name)}&effective_to=is.null`);
        if (existing && existing.length) {
            const closeDate = new Date(effective_from);
            closeDate.setDate(closeDate.getDate() - 1);
            const closeIso = closeDate.toISOString().split('T')[0];
            await sbPatch(env, `plan_rates?id=eq.${existing[0].id}`, { effective_to: closeIso });
        }
        const [created] = await sbPost(env, 'plan_rates', { vendor, plan_name, rate, effective_from, notes });
        return new Response(JSON.stringify(created), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
}

async function handlePlanRatesUpdate(request, env, corsHeaders, url) {
    try {
        const id = url.pathname.split('/').pop();
        if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        const body = await request.json();
        const patch = {};
        if (body.plan_name != null) patch.plan_name = String(body.plan_name).trim();
        if (body.rate != null) patch.rate = parseFloat(body.rate);
        if (body.effective_from != null) patch.effective_from = body.effective_from;
        if ('effective_to' in body) patch.effective_to = body.effective_to;
        if ('notes' in body) patch.notes = body.notes;
        if (!Object.keys(patch).length) return new Response(JSON.stringify({ error: 'no fields to update' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        await sbPatch(env, `plan_rates?id=eq.${encodeURIComponent(id)}`, patch);
        return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
}

async function handlePlanRatesDelete(env, corsHeaders, url) {
    try {
        const id = url.pathname.split('/').pop();
        if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/plan_rates?id=eq.${encodeURIComponent(id)}`, {
            method: 'DELETE',
            headers: {
                'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
                'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
                'Prefer': 'return=minimal',
            },
        });
        if (!resp.ok) return new Response(JSON.stringify({ error: 'delete failed' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
}