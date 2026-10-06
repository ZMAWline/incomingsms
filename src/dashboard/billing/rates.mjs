import { BillingInputError, sanitizeTiers, validateVendor, nonnegativeNumber, validateEffectiveDates } from './validation.mjs';
// Carrier plan rates and reseller pricing rules.
import { parsePositiveInt, badRequest, errorResponse } from '../request.mjs';
import { sbGet, sbPatch } from '../../shared/supabase-rest.mjs';
import { billingFetch, sbPost } from './database.mjs';

// ── Billing Audit (vendor-agnostic, non-prorated) ───────────────────────────
// Plan rates live in the plan_rates table (managed via Plan Rates UI).
// Lookup is by vendor — each vendor has exactly one active plan at a time.

export async function loadActiveRates(env, atDate) {
    const at = atDate ? new Date(atDate).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];
    const rows = await sbGet(env, `plan_rates?or=(effective_to.is.null,effective_to.gte.${at})&effective_from=lte.${at}&order=effective_from.desc`);
    const out = {};
    (rows || []).forEach(r => {
        if (!out[r.vendor]) out[r.vendor] = { rate: parseFloat(r.rate), plan_name: r.plan_name };
    });
    return out;
}

// Plan-name → vendor lookup, used for the Wing aggregator upload where
// the bill mixes ATOMIC/Helix/Wing IoT lines distinguished by plan name.
async function loadActivePlanMap(env, atDate) {
    const at = atDate ? new Date(atDate).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];
    const rows = await sbGet(env, `plan_rates?or=(effective_to.is.null,effective_to.gte.${at})&effective_from=lte.${at}&order=effective_from.desc`);
    const byPlan = {};
    (rows || []).forEach(r => {
        const key = (r.plan_name || '').trim().toLowerCase();
        if (key && !byPlan[key]) byPlan[key] = { vendor: r.vendor, rate: parseFloat(r.rate), plan_name: r.plan_name };
    });
    return byPlan;
}

export const WING_AGGREGATOR_VENDORS = ['wing_iot', 'atomic', 'helix'];

export async function handlePlanRatesList(env, corsHeaders) {
    try {
        const rows = await sbGet(env, 'plan_rates?order=vendor.asc,plan_name.asc,effective_from.desc');
        return new Response(JSON.stringify(rows || []), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (e) {
        return errorResponse(e, corsHeaders);
    }
}

export async function handlePlanRatesCreate(request, env, corsHeaders) {
    try {
        const body = await request.json();
        const vendor = validateVendor(body.vendor);
        const plan_name = (body.plan_name || '').trim();
        const rate = nonnegativeNumber(body.rate, 'rate');
        const effective_from = body.effective_from || new Date().toISOString().split('T')[0];
        const notes = body.notes || null;
        validateEffectiveDates(effective_from, null);
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
        return e instanceof BillingInputError ? badRequest(corsHeaders, e.message) : errorResponse(e, corsHeaders);
    }
}

export async function handlePlanRatesUpdate(request, env, corsHeaders, url) {
    try {
        const id = parsePositiveInt(url.pathname.split('/').pop());
        if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        const body = await request.json();
        const patch = {};
        if (body.plan_name != null) patch.plan_name = String(body.plan_name).trim();
        if (body.rate != null) patch.rate = nonnegativeNumber(body.rate, 'rate');
        if (body.effective_from != null) patch.effective_from = body.effective_from;
        if ('effective_to' in body) patch.effective_to = body.effective_to;
        if ('notes' in body) patch.notes = body.notes;
        validateEffectiveDates(patch.effective_from, patch.effective_to);
        if (!Object.keys(patch).length) return new Response(JSON.stringify({ error: 'no fields to update' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        await sbPatch(env, `plan_rates?id=eq.${encodeURIComponent(id)}`, patch);
        return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (e) {
        return e instanceof BillingInputError ? badRequest(corsHeaders, e.message) : errorResponse(e, corsHeaders);
    }
}

export async function handlePlanRatesDelete(env, corsHeaders, url) {
    try {
        const id = parsePositiveInt(url.pathname.split('/').pop());
        if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        const resp = await billingFetch(env, `${env.SUPABASE_URL}/rest/v1/plan_rates?id=eq.${encodeURIComponent(id)}`, {
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
        return e instanceof BillingInputError ? badRequest(corsHeaders, e.message) : errorResponse(e, corsHeaders);
    }
}

export async function handleResellerRatesList(env, corsHeaders, url) {
    try {
        const resellerParam = url.searchParams.get('reseller_id');
        const resellerId = parsePositiveInt(resellerParam);
        if (resellerParam && !resellerId) return badRequest(corsHeaders, 'reseller_id must be a positive whole number');
        let q = 'reseller_rates?select=id,reseller_id,vendor,effective_from,effective_to,tiers,notes,created_at,updated_at,resellers(name)&order=reseller_id.asc,vendor.asc.nullsfirst,effective_from.desc';
        if (resellerId) q = q.replace('?', '?reseller_id=eq.' + resellerId + '&');
        const rows = await sbGet(env, q);
        const mapped = (rows || []).map(r => Object.assign({}, r, { reseller_name: r.resellers?.name || null }));
        return new Response(JSON.stringify(mapped), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (e) {
        return errorResponse(e, corsHeaders);
    }
}

export async function handleResellerRatesCreate(request, env, corsHeaders) {
    try {
        const body = await request.json();
        const reseller_id = parsePositiveInt(body.reseller_id);
        if (!reseller_id) return badRequest(corsHeaders, 'reseller_id must be a positive whole number');
        const vendor = validateVendor(body.vendor);
        const effective_from = body.effective_from || new Date().toISOString().split('T')[0];
        const effective_to = body.effective_to || null;
        validateEffectiveDates(effective_from, effective_to);
        const tiers = sanitizeTiers(body.tiers);
        const notes = body.notes ? String(body.notes) : null;

        // Auto-close prior open row for same (reseller, vendor)
        const filter = 'reseller_rates?reseller_id=eq.' + reseller_id + '&effective_to=is.null&' + (vendor == null ? 'vendor=is.null' : 'vendor=eq.' + encodeURIComponent(vendor));
        const existing = await sbGet(env, filter);
        if (Array.isArray(existing) && existing.length) {
            const closeDate = new Date(effective_from + 'T12:00:00Z');
            closeDate.setUTCDate(closeDate.getUTCDate() - 1);
            const closeIso = closeDate.toISOString().split('T')[0];
            for (const row of existing) {
                if (row.effective_from > closeIso) continue;
                await sbPatch(env, 'reseller_rates?id=eq.' + row.id, { effective_to: closeIso });
            }
        }
        const [created] = await sbPost(env, 'reseller_rates', { reseller_id, vendor, effective_from, effective_to, tiers, notes });
        return new Response(JSON.stringify(created), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (e) {
        return e instanceof BillingInputError ? badRequest(corsHeaders, e.message) : errorResponse(e, corsHeaders);
    }
}

export async function handleResellerRatesUpdate(request, env, corsHeaders, url) {
    try {
        const id = parsePositiveInt(url.pathname.split('/').pop());
        if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        const body = await request.json();
        const patch = {};
        if (body.effective_from != null) patch.effective_from = body.effective_from;
        if ('effective_to' in body) patch.effective_to = body.effective_to || null;
        if (body.tiers != null) patch.tiers = sanitizeTiers(body.tiers);
        if ('notes' in body) patch.notes = body.notes ? String(body.notes) : null;
        validateEffectiveDates(patch.effective_from, patch.effective_to);
        if (!Object.keys(patch).length) return new Response(JSON.stringify({ error: 'no fields to update' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        await sbPatch(env, 'reseller_rates?id=eq.' + encodeURIComponent(id), patch);
        return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (e) {
        return e instanceof BillingInputError ? badRequest(corsHeaders, e.message) : errorResponse(e, corsHeaders);
    }
}

export async function handleResellerRatesDelete(env, corsHeaders, url) {
    try {
        const id = parsePositiveInt(url.pathname.split('/').pop());
        if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        const resp = await billingFetch(env, env.SUPABASE_URL + '/rest/v1/reseller_rates?id=eq.' + encodeURIComponent(id), {
            method: 'DELETE',
            headers: {
                apikey: env.SUPABASE_SERVICE_ROLE_KEY,
                Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
                Prefer: 'return=minimal',
            },
        });
        if (!resp.ok) return new Response(JSON.stringify({ error: 'delete failed' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (e) {
        return e instanceof BillingInputError ? badRequest(corsHeaders, e.message) : errorResponse(e, corsHeaders);
    }
}
