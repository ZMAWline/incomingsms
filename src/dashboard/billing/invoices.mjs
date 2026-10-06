import { isCalendarDate, isDateRange } from './validation.mjs';
// Customer invoice history, previews and CSV downloads.
import { parsePositiveInt, badRequest, errorResponse, supabaseJson, LEDGER_VENDORS } from '../request.mjs';
import { supabaseGet, billingFetch } from './database.mjs';
import { computeBillingBreakdown, computeResellerUtilization } from '../../shared/billing.js';

export async function handleQboMappingsGet(env, corsHeaders) {
  try {
    const query = `qbo_customer_map?select=id,reseller_id,customer_name,qbo_customer_id,qbo_display_name,daily_rate,resellers(name)&order=id.desc`;
    const response = await supabaseGet(env, query);
    const data = await supabaseJson(response);
    const mapped = (Array.isArray(data) ? data : []).map(m => ({
      ...m,
      reseller_name: m.resellers?.name || null,
    }));
    return new Response(JSON.stringify(mapped), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return errorResponse(error, corsHeaders);
  }
}

export async function handleQboMappingsPost(request, env, corsHeaders) {
  try {
    const body = await request.json();
    const { reseller_id, qbo_customer_id, qbo_display_name, daily_rate } = body;
    if (!qbo_customer_id) return new Response(JSON.stringify({ error: 'qbo_customer_id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    const insertResp = await billingFetch(env, `${env.SUPABASE_URL}/rest/v1/qbo_customer_map`, {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({ reseller_id: reseller_id || null, qbo_customer_id, qbo_display_name, daily_rate: daily_rate || 0.50 }),
    });
    const inserted = await supabaseJson(insertResp);
    return new Response(JSON.stringify(inserted), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return errorResponse(error, corsHeaders);
  }
}

export async function handleQboMappingsDelete(url, env, corsHeaders) {
  try {
    const id = parsePositiveInt(url.searchParams.get('id'));
    if (!id) return badRequest(corsHeaders, 'id must be a positive whole number');
    await billingFetch(env, `${env.SUPABASE_URL}/rest/v1/qbo_customer_map?id=eq.${id}`, {
      method: 'DELETE',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    });
    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return errorResponse(error, corsHeaders);
  }
}

export async function handleQboInvoicesGet(env, corsHeaders) {
  try {
    const query = `qbo_invoices?select=id,week_start,week_end,sim_count,total,status,paid_at,error_message,qbo_customer_map(qbo_display_name)&order=created_at.desc&limit=50`;
    const response = await supabaseGet(env, query);
    const data = await supabaseJson(response);
    const mapped = (Array.isArray(data) ? data : []).map(inv => ({
      ...inv,
      customer_name: inv.qbo_customer_map?.qbo_display_name || null,
    }));
    return new Response(JSON.stringify(mapped), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return errorResponse(error, corsHeaders);
  }
}

export async function handleQboInvoicePatch(request, env, corsHeaders, url) {
  try {
    const id = url.pathname.split('/').pop();
    if (!id || !/^\d+$/.test(id)) return new Response(JSON.stringify({ error: 'invalid id' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    const body = await request.json();
    const patch = {};
    if (typeof body.paid === 'boolean') {
      if (body.paid) {
        patch.status = 'paid';
        patch.paid_at = new Date().toISOString();
      } else {
        patch.status = 'draft';
        patch.paid_at = null;
      }
    }
    if (!Object.keys(patch).length) return new Response(JSON.stringify({ error: 'nothing to update' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    const resp = await billingFetch(env, `${env.SUPABASE_URL}/rest/v1/qbo_invoices?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: {
        'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify(patch),
    });
    if (!resp.ok) return new Response(JSON.stringify({ error: 'update failed' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify({ ok: true, ...patch }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

export async function handleQboInvoiceDelete(env, corsHeaders, url) {
  try {
    const id = url.pathname.split('/').pop();
    if (!id || !/^\d+$/.test(id)) return new Response(JSON.stringify({ error: 'invalid id' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    const resp = await billingFetch(env, env.SUPABASE_URL + '/rest/v1/qbo_invoices?id=eq.' + encodeURIComponent(id), {
      method: 'DELETE',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
        Prefer: 'return=representation',
      },
    });
    if (!resp.ok) return new Response(JSON.stringify({ error: 'delete failed' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    const deleted = await resp.json();
    if (!Array.isArray(deleted) || deleted.length === 0) {
      return new Response(JSON.stringify({ error: 'Invoice not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true, deleted: deleted.length }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

export async function handleQboInvoicePreview(url, env, corsHeaders) {
  // Legacy stub – replaced by /api/billing/preview
  return new Response(JSON.stringify({ error: 'Use /api/billing/preview' }), { status: 410, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

export async function handleBillingPreview(url, env, corsHeaders) {
  try {
    const resellerId = parsePositiveInt(url.searchParams.get('reseller_id'));
    const start = url.searchParams.get('start');
    const end = url.searchParams.get('end');
    if (!resellerId || !isDateRange(start, end)) {
      return badRequest(corsHeaders, 'reseller_id (positive whole number), start and end (YYYY-MM-DD) required');
    }
    // INC-2: optional billing_mode override for the preview (rental testing).
    // Absent => undefined => legacy_simday. Only the exact string 'rental' diverts.
    const billing_mode = url.searchParams.get('billing_mode') || undefined;
    // Optional forward-only cutover override (rental mode only). Absent => default
    // RENTAL_CUTOVER_DATE. Used by dashboard-test to diff against an earlier audit window.
    const cutover = url.searchParams.get('cutover') || undefined;
    if (cutover && !isCalendarDate(cutover)) return badRequest(corsHeaders, 'cutover must be YYYY-MM-DD');
    const result = await computeBillingBreakdown(env, { resellerId, start, end, billing_mode, cutover });
    return new Response(JSON.stringify(result), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error) {
    return errorResponse(error, corsHeaders);
  }
}

export async function handleRentalExport(url, env, corsHeaders) {
  try {
    const resellerId = parsePositiveInt(url.searchParams.get('reseller_id'));
    const start = url.searchParams.get('start');
    const end = url.searchParams.get('end');
    if (!resellerId || !isDateRange(start, end)) {
      return badRequest(corsHeaders, 'reseller_id (positive whole number), start and end (YYYY-MM-DD) required');
    }
    const q = env.SUPABASE_URL + '/rest/v1/rentals?select=id,rental_date,carrier,sim_id,e164,reseller_rental_id'
      + '&reseller_id=eq.' + encodeURIComponent(resellerId)
      + '&rental_date=gte.' + encodeURIComponent(start)
      + '&rental_date=lte.' + encodeURIComponent(end)
      + '&order=rental_date.asc,carrier.asc,sim_id.asc';
    const hdrs = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY, Accept: 'application/json' };
    const lines = ['internal_rental_id,rental_date,carrier,sim_id,mdn,trustotp_rental_id'];
    const PAGE = 1000;
    for (let offset = 0; ; offset += PAGE) {
      const res = await billingFetch(env, q + '&limit=' + PAGE + '&offset=' + offset, { headers: hdrs });
      const rows = await supabaseJson(res);
      if (!Array.isArray(rows) || rows.length === 0) break;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        lines.push([r.id, r.rental_date, r.carrier, r.sim_id, r.e164, (r.reseller_rental_id == null ? '' : r.reseller_rental_id)].join(','));
      }
      if (rows.length < PAGE) break;
    }
    return new Response(lines.join('\n') + '\n', { headers: { ...corsHeaders, 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="rental_rows.csv"' } });
  } catch (error) {
    return errorResponse(error, corsHeaders);
  }
}

export async function handleUtilization(url, env, corsHeaders) {
  try {
    const resellerId = parsePositiveInt(url.searchParams.get('reseller_id'));
    const days = Math.max(1, Math.min(90, parseInt(url.searchParams.get('days') || '7', 10) || 7));
    const vendorParam = url.searchParams.get('vendor');
    if (!resellerId) return badRequest(corsHeaders, 'reseller_id must be a positive whole number');
    // Window: last `days` calendar days in EST, inclusive of today.
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
    const now = new Date();
    const end = fmt.format(now);
    const startD = new Date(now.getTime());
    startD.setUTCDate(startD.getUTCDate() - (days - 1));
    const start = fmt.format(startD);
    const vendors = vendorParam ? vendorParam.split(',').map(s => s.trim()).filter(Boolean) : null;
    if (vendors && vendors.some(v => !LEDGER_VENDORS.includes(v))) {
      return badRequest(corsHeaders, 'Invalid vendor. Valid: ' + LEDGER_VENDORS.join(', '));
    }
    const result = await computeResellerUtilization(env, { resellerId, start, end, vendors });
    return new Response(JSON.stringify(result), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error) {
    return errorResponse(error, corsHeaders);
  }
}

export async function handleBillingCreateInvoice(request, env, corsHeaders) {
  // Kept for backward compatibility but no longer called by the UI.
  return new Response(JSON.stringify({ error: 'Use /api/billing/download-invoice' }), { status: 410, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

function buildCSV(customerName, start, end, days, dailyRate) {
  // QuickBooks Online invoice import CSV format
  const csvField = v => '"' + String(v).replace(/"/g, '""') + '"';
  const rows = [];
  rows.push([
    'InvoiceNo', 'Customer', 'InvoiceDate', 'DueDate', 'Terms',
    'ServiceDate', 'ProductService', 'Description', 'Item Quantity', 'Rate', 'Amount'
  ].map(csvField).join(','));

  // Format date as MM/DD/YYYY for QBO
  const fmtDate = iso => {
    const [y, m, d] = iso.split('-');
    return m + '/' + d + '/' + y;
  };

  const invoiceNo = 'INV-' + start.replace(/-/g, '') + '-' + end.replace(/-/g, '');
  for (const d of days) {
    rows.push([
      invoiceNo,
      customerName,
      fmtDate(end),
      fmtDate(end),
      'Due on receipt',
      d.date ? fmtDate(d.date) : fmtDate(end),
      'US Business phone Rental',
      '',
      d.sim_count,
      (d.rate !== undefined ? d.rate : dailyRate).toFixed(2),
      d.amount.toFixed(2),
    ].map(csvField).join(','));
  }

  return rows.join('\r\n') + '\r\n';
}

export async function handleBillingDownloadInvoice(url, env, corsHeaders) {
  try {
    const invoiceParam = url.searchParams.get('invoice_id');
    const invoiceId = parsePositiveInt(invoiceParam);
    if (invoiceParam && !invoiceId) return badRequest(corsHeaders, 'invoice_id must be a positive whole number');

    if (invoiceId) {
      // Re-download an existing invoice from history
      const invResp = await supabaseGet(env,
        'qbo_invoices?select=id,week_start,week_end,sim_count,total,daily_breakdown,qbo_customer_map(qbo_display_name,daily_rate)&id=eq.' + invoiceId + '&limit=1'
      );
      const invData = await supabaseJson(invResp);
      const inv = Array.isArray(invData) && invData[0] ? invData[0] : null;
      if (!inv) {
        return new Response(JSON.stringify({ error: 'Invoice not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      const customerName = inv.qbo_customer_map?.qbo_display_name || 'Customer';
      const dailyRate = parseFloat(inv.qbo_customer_map?.daily_rate || 0);
      const totalAmount = parseFloat(inv.total);
      // Prefer the per-day breakdown snapshotted at generation time. Invoices
      // generated before the daily_breakdown column existed fall back to a
      // single summary line.
      const days = (Array.isArray(inv.daily_breakdown) && inv.daily_breakdown.length > 0)
        ? inv.daily_breakdown
        : [{ sim_count: inv.sim_count, amount: totalAmount }];
      const csv = buildCSV(customerName, inv.week_start, inv.week_end, days, dailyRate);
      const filename = 'invoice' + customerName.replace(/[^a-z0-9]/gi, '') + String(inv.week_start).replace(/[^0-9]/g, '') + String(inv.week_end).replace(/[^0-9]/g, '') + '.csv';
      return new Response(csv, {
        headers: {
          ...corsHeaders,
          'Content-Type': 'text/csv',
          'Content-Disposition': 'attachment; filename="' + filename + '"',
        },
      });
    }

    // New invoice: reseller_id + start + end
    const resellerId = parsePositiveInt(url.searchParams.get('reseller_id'));
    const start = url.searchParams.get('start');
    const end = url.searchParams.get('end');
    if (!resellerId || !isDateRange(start, end)) {
      return badRequest(corsHeaders, 'reseller_id (positive whole number), start and end (YYYY-MM-DD) required');
    }

    const billing_mode = url.searchParams.get('billing_mode') || undefined;
    const breakdown = await computeBillingBreakdown(env, { resellerId, start, end, billing_mode });
    if (!breakdown.mapping) {
      return new Response(JSON.stringify({ error: 'No customer rate configured for this reseller' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    const mapping = breakdown.mapping;
    const dailyRate = breakdown.daily_rate;
    const days = breakdown.days;
    const totalSimDays = breakdown.total_sim_days;
    const totalAmount = breakdown.total_amount;

    if (totalSimDays === 0) {
      return new Response(JSON.stringify({ error: 'No billable SIM-days in this range' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Record in qbo_invoices
    await billingFetch(env, env.SUPABASE_URL + '/rest/v1/qbo_invoices', {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        qbo_customer_map_id: mapping.id,
        qbo_invoice_id: null,
        week_start: start,
        week_end: end,
        sim_count: totalSimDays,
        total: totalAmount,
        status: 'draft',
        daily_breakdown: days,
      }),
    });

    const csv = buildCSV(mapping.qbo_display_name, start, end, days, dailyRate);
    const filename = 'invoice' + mapping.qbo_display_name.replace(/[^a-z0-9]/gi, '') + String(start).replace(/[^0-9]/g, '') + String(end).replace(/[^0-9]/g, '') + '.csv';
    return new Response(csv, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/csv',
        'Content-Disposition': 'attachment; filename="' + filename + '"',
      },
    });
  } catch (error) {
    return errorResponse(error, corsHeaders);
  }
}
