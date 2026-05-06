async function handleBillingLedgerList(env, corsHeaders, url) {
    try {
        const filters = [];
        const sim_id = url.searchParams.get('sim_id');
        const vendor = url.searchParams.get('vendor');
        const status = url.searchParams.get('status');
        const periodMonth = url.searchParams.get('period_month'); // YYYY-MM
        if (sim_id) filters.push(`sim_id=eq.${encodeURIComponent(sim_id)}`);
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

        const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
            headers: {
                'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
                'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
                'Prefer': 'count=exact',
            },
        });
        const rows = await resp.json();
        const cr = resp.headers.get('content-range') || '*/0';
        const total = parseInt(cr.split('/')[1] || '0');
        return new Response(JSON.stringify({ rows: rows || [], total, limit, offset }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
}

async function handleBillingLedgerMonths(env, corsHeaders) {
    try {
        const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/get_ledger_months`, {
            method: 'POST',
            headers: {
                'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
                'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
                'Content-Type': 'application/json',
            },
            body: '{}',
        });
        const rows = await resp.json();
        const months = (rows || []).map(r => r.month).filter(Boolean);
        return new Response(JSON.stringify({ months }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
}