// QuickBooks Online worker. Called only via the dashboard's QUICKBOOKS service
// binding (no public URL).
//
// Auth is the owner's Composio QuickBooks connection, not an OAuth flow of our
// own: every call runs a Composio QuickBooks tool against that connected
// account. QuickBooks emails an invoice to the customer's on-file address as
// soon as it is created (verified on invoices 1203, 1205, 1450: DeliveryTime
// equals CreateTime), so there is no separate send step.

import { carrierFetch } from '../shared/fetch-timeout.mjs';

const COMPOSIO_API = 'https://backend.composio.dev/api/v3';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      // Check connection status
      if (url.pathname === '/status') {
        return await handleStatus(env);
      }

      // Search QBO customers
      if (url.pathname === '/customers/search') {
        return await handleCustomerSearch(url, env);
      }

      // Create invoice
      if (url.pathname === '/invoice/create' && request.method === 'POST') {
        return await handleCreateInvoice(request, env);
      }

      // Search QBO items (used to resolve ItemRef.value by name)
      if (url.pathname === '/items/search') {
        return await handleItemSearch(url, env);
      }

      // Query invoices by DocNumber (duplicate guard / reconciliation)
      if (url.pathname === '/invoice/query') {
        return await handleInvoiceQuery(url, env);
      }

      // Read back a single invoice by QBO Id
      const readMatch = url.pathname.match(/^\/invoice\/([^/]+)$/);
      if (readMatch && request.method === 'GET') {
        return await handleReadInvoice(readMatch[1], env);
      }

      return json({ error: 'Not found' }, 404);
    } catch (e) {
      console.error('QuickBooks worker error:', e);
      return json({ error: String(e) }, 500);
    }
  },
};

// ===== Status =====

async function handleStatus(env) {
  const res = await carrierFetch(env, `${COMPOSIO_API}/connected_accounts/${env.COMPOSIO_CONNECTED_ACCOUNT_ID}`, {
    headers: composioHeaders(env),
  });
  if (!res.ok) return json({ connected: false, via: 'composio', error: `Composio ${res.status}` });
  const account = await res.json();
  return json({ connected: account.status === 'ACTIVE' && !account.is_disabled, status: account.status, via: 'composio' });
}

// ===== QBO API Handlers =====

async function handleCustomerSearch(url, env) {
  const q = url.searchParams.get('q') || '';
  const query = q
    ? `SELECT * FROM Customer WHERE DisplayName LIKE '%${q.replace(/'/g, "\\'")}%' MAXRESULTS 20`
    : 'SELECT * FROM Customer MAXRESULTS 50';

  const data = await qboQuery(env, query);
  const customers = data?.QueryResponse?.Customer || [];

  return json(customers.map(c => ({
    id: c.Id,
    displayName: c.DisplayName,
    companyName: c.CompanyName,
    active: c.Active,
  })));
}

async function handleCreateInvoice(request, env) {
  const body = await request.json();
  // body: { customerId, lineItems: [{ itemId, description, quantity, rate, amount }],
  //         dueDate, txnDate, docNumber, customerMemo, requestId }
  // requestId is QBO's create-time idempotency key: a retry with the same
  // requestId returns the original invoice instead of creating a duplicate.

  const { customerId, lineItems, dueDate, txnDate, docNumber, customerMemo, requestId } = body;
  if (!customerId || !lineItems?.length) {
    return json({ error: 'Missing customerId or lineItems' }, 400);
  }

  const args = {
    customer_id: customerId,
    due_date: dueDate || undefined,
    txn_date: txnDate || undefined,
    doc_number: docNumber || undefined,
    requestid: requestId || undefined,
    // Manual/pay-by-invoice customers only — no online payment buttons on
    // the emailed invoice.
    allow_ipn_payment: false,
    allow_online_ach_payment: false,
    allow_online_credit_card_payment: false,
    lines: lineItems.map((item) => ({
      DetailType: 'SalesItemLineDetail',
      Amount: item.amount,
      Description: item.description,
      SalesItemLineDetail: {
        ItemRef: item.itemId ? { value: item.itemId } : undefined,
        UnitPrice: item.rate,
        Qty: item.quantity,
      },
    })),
  };
  if (customerMemo) args.customer_memo = { value: customerMemo };

  const result = await composioTool(env, 'QUICKBOOKS_CREATE_INVOICE', args);
  return json(mapInvoice(result?.Invoice || result || {}));
}

async function handleItemSearch(url, env) {
  const q = url.searchParams.get('q') || '';
  const query = q
    ? `SELECT * FROM Item WHERE Name = '${q.replace(/'/g, "\\'")}' MAXRESULTS 20`
    : 'SELECT * FROM Item MAXRESULTS 50';

  const data = await qboQuery(env, query);
  const items = data?.QueryResponse?.Item || [];

  return json(items.map(i => ({ id: i.Id, name: i.Name, active: i.Active, type: i.Type })));
}

async function handleInvoiceQuery(url, env) {
  const docNumber = url.searchParams.get('doc_number');
  if (!docNumber) return json({ error: 'doc_number required' }, 400);

  const query = `SELECT * FROM Invoice WHERE DocNumber = '${docNumber.replace(/'/g, "\\'")}'`;
  const data = await qboQuery(env, query);
  const invoices = data?.QueryResponse?.Invoice || [];

  return json(invoices.map(mapInvoice));
}

async function handleReadInvoice(id, env) {
  const data = await composioTool(env, 'QUICKBOOKS_READ_INVOICE', { invoice_id: id });
  const inv = data?.Invoice || data;
  if (!inv?.Id) return json({ error: 'Invoice not found' }, 404);
  return json(mapInvoice(inv));
}

function mapInvoice(inv) {
  return {
    id: inv.Id,
    docNumber: inv.DocNumber,
    customerId: inv.CustomerRef?.value,
    customerName: inv.CustomerRef?.name,
    txnDate: inv.TxnDate,
    totalAmt: inv.TotalAmt,
    balance: inv.Balance,
    emailStatus: inv.EmailStatus,
    billEmail: inv.BillEmail?.Address,
    deliveredAt: inv.DeliveryInfo?.DeliveryTime,
    lineCount: Array.isArray(inv.Line) ? inv.Line.length : 0,
  };
}

// ===== Composio =====

// COMPOSIO_API_KEY is the owner's Composio user key (secret). The connected
// account lives in the owner's Composio consumer project, which is why the
// org, project and user ids are needed alongside it.
function composioHeaders(env) {
  return {
    'x-user-api-key': env.COMPOSIO_API_KEY,
    'x-org-id': env.COMPOSIO_ORG_ID,
    'x-project-id': env.COMPOSIO_PROJECT_ID,
    'Content-Type': 'application/json',
  };
}

async function composioTool(env, slug, args) {
  const res = await carrierFetch(env, `${COMPOSIO_API}/tools/execute/${slug}`, {
    method: 'POST',
    headers: composioHeaders(env),
    body: JSON.stringify({
      version: 'latest',
      user_id: env.COMPOSIO_USER_ID,
      connected_account_id: env.COMPOSIO_CONNECTED_ACCOUNT_ID,
      arguments: args,
    }),
  });
  const text = await res.text();
  let out;
  try { out = JSON.parse(text); } catch { out = null; }
  if (!res.ok || !out?.successful) {
    const detail = out?.error ? JSON.stringify(out.error) : text;
    console.error(`Composio ${slug} failed (${res.status}):`, detail);
    throw new Error(`Composio ${slug} failed (${res.status}): ${detail}`);
  }
  return out.data;
}

function qboQuery(env, query) {
  return composioTool(env, 'QUICKBOOKS_QUERY_ENTITIES', { query });
}

// ===== Helpers =====

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
