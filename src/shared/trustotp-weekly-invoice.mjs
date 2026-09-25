// TrustOTP weekly QuickBooks invoice automation.
//
// The durable Friday job for the TrustOTP / HYPPE TECH weekly invoice. It uses
// the dashboard billing engine (computeBillingBreakdown) as the source of truth
// for line items, and creates + sends the invoice through the native
// `quickbooks` Worker (src/quickbooks/index.js, bound as env.QUICKBOOKS on the
// dashboard) — the already-deployed, in-repo QuickBooks Online integration,
// not an external SaaS dependency.
//
// Idempotency:
//  - One local qbo_invoices row per (qbo_customer_map_id, week_start), enforced
//    by the table's UNIQUE constraint. Before creating, this module looks up
//    that row; if it already carries a QBO invoice id, creation is skipped.
//  - Before creating in QBO, it also queries QBO directly for an Invoice with
//    the same DocNumber, so a crash between "QBO create succeeded" and "local
//    row written" can never produce a duplicate QBO invoice on retry.
//  - Sending is gated the same way: a local row already marked 'sent' is never
//    re-sent. A row that is 'created' but not yet 'sent' (e.g. create
//    succeeded, send failed, or crashed in between) is sent on retry without
//    creating a second invoice.
//
// NOTE: computeBillingBreakdown is imported lazily (not at module top) so
// callers can inject env.computeBillingBreakdown for testing and so the module
// loads under both the Cloudflare Worker bundler and local Node test runners.

import { supabaseFetch } from './fetch-timeout.mjs';

// TrustOTP reseller id. Inherited from the qbo_customer_map -> resellers
// wiring already used by the dashboard's billing preview / CSV-download path
// for this customer (src/dashboard/index.js handleBillingDownloadInvoice).
// Not independently re-verified against live QuickBooks/Supabase by this
// module — see the PR description for what would confirm it.
export const TRUSTOTP_RESELLER_ID = 3;

// The QBO Item whose Name matches this is used for every line. Resolved by
// name at call time via /items/search rather than hardcoding a numeric
// Item.Id, which is not stable across QuickBooks company data changes. Same
// product name the CSV-download path already uses (buildCSV in
// src/dashboard/index.js).
const QBO_ITEM_NAME = 'US Business phone Rental';

// ---- Date helpers (America/New_York weeks: Friday start -> Thursday end) ----

// Compute the Friday..Thursday week that should be invoiced next.
// `latestEnd` is the week_end (YYYY-MM-DD) of the most recent invoiced week, or null.
// Returns { start, end } in America/New_York calendar terms.
// Uses noon-UTC to avoid DST shifts when doing day arithmetic on ISO calendar dates.
export function computeNextUninvoicedWeek(latestEnd) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
  const noonOf = (iso) => new Date(iso + 'T12:00:00Z'); // noon UTC is stable for day math
  const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
  if (!latestEnd) {
    // Return the most recently completed week (last Friday..Thursday).
    const todayNY = noonOf(fmt.format(new Date())); // today at noon in NY
    const dow = todayNY.getUTCDay(); // 0 Sun .. 5 Fri .. 6 Sat
    const daysSinceFriday = (dow + 2) % 7;
    const thisFriday = addDays(todayNY, -daysSinceFriday);
    const thisThursday = addDays(thisFriday, 6);
    if (todayNY > thisThursday) {
      return { start: fmt.format(thisFriday), end: fmt.format(thisThursday) };
    } else {
      const prevFriday = addDays(thisFriday, -7);
      const prevThursday = addDays(prevFriday, 6);
      return { start: fmt.format(prevFriday), end: fmt.format(prevThursday) };
    }
  }
  // latestEnd is a Thursday. Next week starts on the following Friday (+1 day).
  const nextStart = addDays(noonOf(latestEnd), 1);
  const nextEnd = addDays(nextStart, 6);
  return { start: fmt.format(nextStart), end: fmt.format(nextEnd) };
}

function docNumberFor(start, end) {
  return `INV-${start.replace(/-/g, '')}-${end.replace(/-/g, '')}`;
}

// ---- QuickBooks worker (service binding) ----

async function qbo(env, path, options) {
  if (!env.QUICKBOOKS) throw new Error('QUICKBOOKS service binding not configured');
  const res = await env.QUICKBOOKS.fetch(`https://quickbooks${path}`, options);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* fall through with null */ }
  if (!res.ok) {
    const detail = (data && data.error) || text.slice(0, 300);
    throw new Error(`QuickBooks worker error ${res.status} on ${path}: ${detail}`);
  }
  return data;
}

async function resolveItemId(env) {
  const items = await qbo(env, `/items/search?q=${encodeURIComponent(QBO_ITEM_NAME)}`);
  const match = Array.isArray(items) ? items.find((i) => i.name === QBO_ITEM_NAME && i.active !== false) : null;
  if (!match) throw new Error(`QuickBooks item "${QBO_ITEM_NAME}" not found (or inactive)`);
  return match.id;
}

async function findQboInvoiceByDocNumber(env, docNumber) {
  const invoices = await qbo(env, `/invoice/query?doc_number=${encodeURIComponent(docNumber)}`);
  return Array.isArray(invoices) && invoices.length ? invoices[0] : null;
}

// ---- Local reconciliation storage (qbo_invoices) ----

function sbHeaders(env, extra) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    ...(extra || {}),
  };
}

async function localInvoiceForWeek(env, mappingId, start) {
  const resp = await supabaseFetch(
    env,
    `${env.SUPABASE_URL}/rest/v1/qbo_invoices?select=id,qbo_invoice_id,doc_number,status,email_status,total` +
      `&qbo_customer_map_id=eq.${mappingId}&week_start=eq.${start}&limit=1`,
    { headers: sbHeaders(env, { Accept: 'application/json' }) }
  );
  if (!resp.ok) throw new Error(`Local invoice lookup failed: ${resp.status}`);
  const rows = await resp.json();
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function latestInvoicedWeekEnd(env, mappingId) {
  const resp = await supabaseFetch(
    env,
    `${env.SUPABASE_URL}/rest/v1/qbo_invoices?select=week_end&qbo_customer_map_id=eq.${mappingId}&order=week_end.desc&limit=1`,
    { headers: sbHeaders(env, { Accept: 'application/json' }) }
  );
  if (!resp.ok) throw new Error(`Latest invoiced week lookup failed: ${resp.status}`);
  const rows = await resp.json();
  return Array.isArray(rows) && rows[0] ? rows[0].week_end : null;
}

async function insertLocalInvoice(env, row) {
  const resp = await supabaseFetch(env, `${env.SUPABASE_URL}/rest/v1/qbo_invoices`, {
    method: 'POST',
    headers: sbHeaders(env, { 'Content-Type': 'application/json', Prefer: 'return=representation' }),
    body: JSON.stringify(row),
  });
  if (!resp.ok) throw new Error(`Failed to record local invoice: ${resp.status} ${await resp.text()}`);
  const inserted = await resp.json();
  return Array.isArray(inserted) ? inserted[0] : inserted;
}

async function patchLocalInvoice(env, id, patch) {
  const resp = await supabaseFetch(env, `${env.SUPABASE_URL}/rest/v1/qbo_invoices?id=eq.${id}`, {
    method: 'PATCH',
    headers: sbHeaders(env, { 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
    body: JSON.stringify(patch),
  });
  if (!resp.ok) throw new Error(`Failed to update local invoice ${id}: ${resp.status} ${await resp.text()}`);
}

// ---- Main entry ----

// latestEnd: the week_end of the most recently invoiced week (YYYY-MM-DD) or null.
// dry_run (default true): compute and return the would-be invoice without
// touching QuickBooks or Supabase.
export async function runTrustotpWeeklyInvoice(env, { dry_run = true, latestEnd = null } = {}) {
  const resellerId = TRUSTOTP_RESELLER_ID;
  const { start, end } = computeNextUninvoicedWeek(latestEnd);
  const docNumber = docNumberFor(start, end);

  const computeBillingBreakdown = env.computeBillingBreakdown || (await import('./billing.js')).computeBillingBreakdown;
  const breakdown = await computeBillingBreakdown(env, { resellerId, start, end });
  if (!breakdown.mapping) {
    throw new Error('No customer rate configured for TrustOTP reseller (qbo_customer_map missing)');
  }
  const mapping = breakdown.mapping;
  const days = breakdown.days;
  const totalSimDays = breakdown.total_sim_days;
  const totalAmount = breakdown.total_amount;

  if (totalSimDays === 0) {
    return { created: false, sent: false, skipped: true, reason: 'no_billable_sim_days', week: { start, end }, docNumber };
  }

  if (dry_run) {
    return {
      dry_run: true,
      created: false,
      sent: false,
      week: { start, end },
      docNumber,
      totalSimDays,
      totalAmount,
      lineCount: days.length,
      days,
    };
  }

  let local = await localInvoiceForWeek(env, mapping.id, start);
  if (local && local.status === 'sent') {
    return { created: false, sent: false, skipped: true, reason: 'already_sent', week: { start, end }, docNumber, existing: local };
  }

  let qboInvoiceId = local?.qbo_invoice_id || null;
  let created = false;

  if (!qboInvoiceId) {
    // Duplicate guard: check QuickBooks by DocNumber before creating, in case
    // a prior run created the invoice but crashed before the local write.
    const existingQbo = await findQboInvoiceByDocNumber(env, docNumber);
    if (existingQbo) {
      qboInvoiceId = existingQbo.id;
    } else {
      const itemId = await resolveItemId(env);
      const invoice = await qbo(env, '/invoice/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerId: mapping.qbo_customer_id,
          docNumber,
          txnDate: end,
          dueDate: end,
          requestId: docNumber.slice(0, 50), // QBO create-time idempotency key
          customerMemo: `Weekly US Business phone Rental invoice for ${start} to ${end}.`,
          lineItems: days.map((d) => ({
            itemId,
            description: d.date,
            quantity: d.sim_count,
            rate: d.rate,
            amount: d.amount,
          })),
        }),
      });
      qboInvoiceId = invoice.id;
      created = true;
    }

    const patch = {
      qbo_customer_map_id: mapping.id,
      qbo_invoice_id: qboInvoiceId,
      doc_number: docNumber,
      week_start: start,
      week_end: end,
      sim_count: totalSimDays,
      total: totalAmount,
      status: 'created',
      daily_breakdown: days,
    };
    if (local) {
      await patchLocalInvoice(env, local.id, patch);
      local = { ...local, ...patch };
    } else {
      local = await insertLocalInvoice(env, patch);
    }
  }

  // ---- Send (never twice — guarded above by local.status === 'sent') ----
  const sentInvoice = await qbo(env, `/invoice/${encodeURIComponent(qboInvoiceId)}/send`, { method: 'POST' });

  await patchLocalInvoice(env, local.id, {
    status: 'sent',
    email_status: sentInvoice.emailStatus || 'EmailSent',
    sent_at: new Date().toISOString(),
  });

  return {
    created,
    sent: true,
    week: { start, end },
    docNumber: sentInvoice.docNumber || docNumber,
    qboInvoiceId,
    emailStatus: sentInvoice.emailStatus,
    totalSimDays,
    totalAmount,
  };
}

// Resolves the latest invoiced week from Supabase and runs for real
// (dry_run: false). This is what the Friday cron calls — see
// src/dashboard/index.js `scheduled()`.
export async function runScheduledTrustotpInvoice(env) {
  const resp = await supabaseFetch(
    env,
    `${env.SUPABASE_URL}/rest/v1/qbo_customer_map?select=id&reseller_id=eq.${TRUSTOTP_RESELLER_ID}&limit=1`,
    { headers: sbHeaders(env, { Accept: 'application/json' }) }
  );
  if (!resp.ok) throw new Error(`qbo_customer_map lookup failed: ${resp.status}`);
  const rows = await resp.json();
  const mapping = Array.isArray(rows) && rows[0] ? rows[0] : null;
  const latestEnd = mapping ? await latestInvoicedWeekEnd(env, mapping.id) : null;
  return runTrustotpWeeklyInvoice(env, { dry_run: false, latestEnd });
}
