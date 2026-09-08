// TrustOTP weekly QuickBooks invoice automation (Composio path).
//
// This is the durable Friday job for the TrustOTP / HYPPE TECH weekly invoice.
// It uses the IncomingSMS dashboard billing engine (computeBillingBreakdown) as the
// source of truth for line items, and creates the QuickBooks invoice through the
// approved Composio QuickBooks toolkit — NOT the legacy quickbooks worker (which is
// dead/retired).
//
// Safety rules (per task):
//  - Invoices are created UNSENT. No bill_email, no online-payment fields, no send call.
//  - A duplicate guard checks QuickBooks by DocNumber AND the local qbo_invoices table
//    before creating, so re-runs never double-bill.
//  - COMPOSIO_API_KEY must be present in worker secrets; the job fails safe if missing.
//
// NOTE: computeBillingBreakdown is imported lazily inside runTrustotpWeeklyInvoice (not at
// module top) so callers can inject env.computeBillingBreakdown for testing and so the module
// loads under both the Cloudflare Worker bundler and local Node test runners.

// TrustOTP reseller id (verified: reseller_id = 3 -> HYPPE TECH).
export const TRUSTOTP_RESELLER_ID = 3;

// QuickBooks customer + item (verified live): HYPPE TECH id 39, item "US Business phone Rental" id 7.
const QBO_CUSTOMER_ID = '39';
const QBO_ITEM_ID = '7';

// Composio connection (verified live 2026-08-28):
//   org ok_5eczhoDdDSpF, project pr_EeP6iHeAG5V9,
//   connected account ca_eT3qsHkOYV3V (CLI alias quickbooks_tapete-hanch)
const COMPOSIO_ORG_ID = 'ok_5eczhoDdDSpF';
const COMPOSIO_PROJECT_ID = 'pr_EeP6iHeAG5V9';
const COMPOSIO_CONSUMER_USER_ID = 'consumer-307052ff-cc7d-4efc-b9f5-c0d04f25821b-ok_5eczhoDdDSpF';
const COMPOSIO_CONNECTED_ACCOUNT = 'ca_eT3qsHkOYV3V';
const COMPOSIO_BASE = 'https://backend.composio.dev';

// ---- Date helpers (America/New_York weeks: Friday start -> Thursday end) ----

function fmtEst(iso) {
  // ISO date (YYYY-MM-DD) -> MM/DD/YYYY for QBO
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
}

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

// ---- Composio REST (tool_router session pattern, verified live) ----

async function composioExecute(env, toolSlug, args) {
  const apiKey = env.COMPOSIO_API_KEY;
  if (!apiKey) throw new Error('COMPOSIO_API_KEY not configured');
  const headers = {
    'x-user-api-key': apiKey,
    'x-org-id': COMPOSIO_ORG_ID,
    'x-project-id': COMPOSIO_PROJECT_ID,
    'Content-Type': 'application/json',
  };
  // 1) open a tool_router session
  const sessRes = await fetch(`${COMPOSIO_BASE}/api/v3.1/tool_router/session`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      user_id: COMPOSIO_CONSUMER_USER_ID,
      connected_accounts: { quickbooks: COMPOSIO_CONNECTED_ACCOUNT },
      manage_connections: { enable: true },
      experimental: { link_url_overwrite: 'https://connect.composio.dev/enhanced' },
    }),
  });
  if (!sessRes.ok) {
    const t = await sessRes.text();
    throw new Error(`Composio session create failed ${sessRes.status}: ${t.slice(0, 300)}`);
  }
  const sess = await sessRes.json();
  const sessionId = sess.session_id || sess.id || sess.data?.session_id || sess.data?.id;
  if (!sessionId) throw new Error('Composio session create response did not include session_id');
  // 2) execute the tool in that session
  const execRes = await fetch(`${COMPOSIO_BASE}/api/v3.1/tool_router/session/${sessionId}/execute`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ tool_slug: toolSlug, arguments: args }),
  });
  if (!execRes.ok) {
    const t = await execRes.text();
    throw new Error(`Composio ${toolSlug} failed ${execRes.status}: ${t.slice(0, 300)}`);
  }
  return execRes.json();
}

// ---- QuickBooks helpers ----

function docNumberFor(start, end) {
  return `INV-${start.replace(/-/g, '')}-${end.replace(/-/g, '')}`;
}

async function qboInvoiceExistsByDocNumber(env, docNumber) {
  try {
    const r = await composioExecute(env, 'QUICKBOOKS_QUERY_ENTITIES', {
      query: `SELECT * FROM Invoice WHERE DocNumber = '${docNumber}'`,
    });
    const invs = r?.data?.QueryResponse?.Invoice || [];
    return invs.length > 0 ? invs[0] : null;
  } catch (e) {
    // A query error should not silently bypass the guard; rethrow so we fail safe.
    throw new Error(`Duplicate guard query failed: ${e.message}`);
  }
}

async function localInvoiceExists(env, start, end) {
  const resp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/qbo_invoices?select=id,qbo_invoice_id,status&week_start=eq.${start}&week_end=eq.${end}&status=in.(created,sent)&limit=1`,
    { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } }
  );
  if (!resp.ok) return false;
  const rows = await resp.json();
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

async function readBackInvoice(env, qboInvoiceId) {
  const r = await composioExecute(env, 'QUICKBOOKS_READ_INVOICE', { invoice_id: String(qboInvoiceId) });
  const inv = r?.data?.Invoice || r?.data?.invoice || r?.data;
  return {
    docNumber: inv?.DocNumber,
    customer: inv?.CustomerRef?.name,
    customerId: inv?.CustomerRef?.value,
    txnDate: inv?.TxnDate,
    lineCount: Array.isArray(inv?.Line) ? inv.Line.length : 0,
    total: inv?.TotalAmt,
    balance: inv?.Balance,
    emailStatus: inv?.EmailStatus,
    eInvoiceStatus: inv?.EInvoiceStatus,
  };
}

async function recordLocalInvoice(env, { mappingId, qboInvoiceId, start, end, totalSimDays, total, days }) {
  await fetch(`${env.SUPABASE_URL}/rest/v1/qbo_invoices`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({
      qbo_customer_map_id: mappingId,
      qbo_invoice_id: qboInvoiceId,
      week_start: start,
      week_end: end,
      sim_count: totalSimDays,
      total,
      status: 'created', // never 'sent' — invoices stay unsent for review
      daily_breakdown: days,
    }),
  });
}

// ---- Main entry ----

// latestEnd: the week_end of the most recently invoiced week (YYYY-MM-DD) or null.
export async function runTrustotpWeeklyInvoice(env, { dry_run = true, latestEnd = null } = {}) {
  const resellerId = TRUSTOTP_RESELLER_ID;
  const { start, end } = computeNextUninvoicedWeek(latestEnd);
  const docNumber = docNumberFor(start, end);

  const breakdown = await (env.computeBillingBreakdown || (await import('./billing.js')).computeBillingBreakdown)(env, { resellerId, start, end });
  if (!breakdown.mapping) {
    throw new Error('No customer rate configured for TrustOTP reseller (qbo_customer_map missing)');
  }
  const mapping = breakdown.mapping;
  const days = breakdown.days;
  const totalSimDays = breakdown.total_sim_days;
  const totalAmount = breakdown.total_amount;

  if (totalSimDays === 0) {
    return { created: false, skipped: true, reason: 'no_billable_sim_days', week: { start, end }, docNumber };
  }

  // Duplicate guard: QuickBooks by DocNumber first.
  const existingQbo = await qboInvoiceExistsByDocNumber(env, docNumber);
  if (existingQbo) {
    return {
      created: false,
      skipped: true,
      reason: 'duplicate_docnumber_qbo',
      week: { start, end },
      docNumber,
      existing: { qboInvoiceId: existingQbo.Id, docNumber: existingQbo.DocNumber, total: existingQbo.TotalAmt },
    };
  }
  // Duplicate guard: local qbo_invoices table.
  const existingLocal = await localInvoiceExists(env, start, end);
  if (existingLocal) {
    return {
      created: false,
      skipped: true,
      reason: 'duplicate_local',
      week: { start, end },
      docNumber,
      existing: existingLocal,
    };
  }

  if (dry_run) {
    return {
      dry_run: true,
      created: false,
      week: { start, end },
      docNumber,
      customerId: QBO_CUSTOMER_ID,
      itemId: QBO_ITEM_ID,
      totalSimDays,
      totalAmount,
      lineCount: days.length,
      days,
    };
  }

  // Build Composio create args. UNSENT: no bill_email, no online payment, no send.
  const lines = days.map((d) => ({
    DetailType: 'SalesItemLineDetail',
    Amount: d.amount,
    SalesItemLineDetail: {
      ItemRef: { value: QBO_ITEM_ID },
      Qty: d.sim_count,
      UnitPrice: d.rate,
    },
    Description: d.date,
  }));

  const createArgs = {
    customer_id: QBO_CUSTOMER_ID,
    doc_number: docNumber,
    txn_date: end,
    due_date: end,
    requestid: docNumber.slice(0, 50), // idempotency key
    customer_memo: { value: `Weekly US Business phone Rental invoice for ${start} to ${end}.` },
    allow_ipn_payment: false,
    allow_online_payment: false,
    allow_online_ach_payment: false,
    allow_online_credit_card_payment: false,
    lines,
  };

  const created = await composioExecute(env, 'QUICKBOOKS_CREATE_INVOICE', createArgs);
  const qboInvoiceId = created?.data?.Invoice?.Id || created?.data?.Id || created?.data?.id || created?.data?.invoice_id;
  if (!qboInvoiceId) {
    throw new Error(`Composio create returned no invoice id: ${JSON.stringify(created).slice(0, 300)}`);
  }

  const readback = await readBackInvoice(env, qboInvoiceId);
  await recordLocalInvoice(env, {
    mappingId: mapping.id,
    qboInvoiceId,
    start,
    end,
    totalSimDays,
    total: totalAmount,
    days,
  });

  return {
    created: true,
    week: { start, end },
    docNumber,
    qboInvoiceId,
    readback,
    totalSimDays,
    totalAmount,
  };
}

export { fmtEst };
