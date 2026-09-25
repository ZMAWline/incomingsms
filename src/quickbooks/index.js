import { carrierFetch } from '../shared/fetch-timeout.mjs';
// QuickBooks Online OAuth + API proxy worker
// Called via service binding from dashboard worker

const QBO_AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
const QBO_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const QBO_API_BASE = 'https://quickbooks.api.intuit.com/v3/company';
// Sandbox base for testing:
// const QBO_API_BASE = 'https://sandbox-quickbooks.api.intuit.com/v3/company';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      // OAuth: get authorization URL
      if (url.pathname === '/auth-url') {
        return handleAuthUrl(env);
      }

      // OAuth: callback with authorization code
      if (url.pathname === '/callback') {
        return handleCallback(url, env);
      }

      // Check connection status
      if (url.pathname === '/status') {
        return handleStatus(env);
      }

      // Disconnect (clear tokens)
      if (url.pathname === '/disconnect' && request.method === 'POST') {
        return handleDisconnect(env);
      }

      // Search QBO customers
      if (url.pathname === '/customers/search') {
        return handleCustomerSearch(url, env);
      }

      // Create invoice
      if (url.pathname === '/invoice/create' && request.method === 'POST') {
        return handleCreateInvoice(request, env);
      }

      // Search QBO items (used to resolve ItemRef.value by name)
      if (url.pathname === '/items/search') {
        return handleItemSearch(url, env);
      }

      // Query invoices by DocNumber (duplicate guard / reconciliation)
      if (url.pathname === '/invoice/query') {
        return handleInvoiceQuery(url, env);
      }

      // Send an existing invoice by email (defaults to the customer's
      // on-file email; ?sendTo= overrides it)
      const sendMatch = url.pathname.match(/^\/invoice\/([^/]+)\/send$/);
      if (sendMatch && request.method === 'POST') {
        return handleSendInvoice(sendMatch[1], url, env);
      }

      // Read back a single invoice by QBO Id
      const readMatch = url.pathname.match(/^\/invoice\/([^/]+)$/);
      if (readMatch && request.method === 'GET') {
        return handleReadInvoice(readMatch[1], env);
      }

      return json({ error: 'Not found' }, 404);
    } catch (e) {
      console.error('QuickBooks worker error:', e);
      return json({ error: String(e) }, 500);
    }
  },
};

// ===== Relay =====

function relayFetch(env, url, init, send = carrierFetch) {
  if (env.RELAY_URL && env.RELAY_KEY) {
    return send(env, `${env.RELAY_URL}/${url}`, {
      ...init,
      headers: { ...(init?.headers || {}), 'x-relay-key': env.RELAY_KEY },
    });
  }
  return send(env, url, init);
}

// ===== OAuth Handlers =====

function handleAuthUrl(env) {
  const params = new URLSearchParams({
    client_id: env.QBO_CLIENT_ID,
    response_type: 'code',
    scope: 'com.intuit.quickbooks.accounting',
    redirect_uri: env.QBO_REDIRECT_URI,
    state: crypto.randomUUID(),
  });
  return json({ url: `${QBO_AUTH_URL}?${params}` });
}

async function handleCallback(url, env) {
  const code = url.searchParams.get('code');
  const realmId = url.searchParams.get('realmId');

  if (!code || !realmId) {
    return json({ error: 'Missing code or realmId' }, 400);
  }

  const tokenRes = await relayFetch(env, QBO_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + btoa(`${env.QBO_CLIENT_ID}:${env.QBO_CLIENT_SECRET}`),
      'Accept': 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: env.QBO_REDIRECT_URI,
    }),
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    console.error('Token exchange failed:', errText);
    return json({ error: 'Token exchange failed', details: errText }, 400);
  }

  const tokens = await tokenRes.json();
  await storeTokens(env, {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    realm_id: realmId,
    expires_at: Date.now() + (tokens.expires_in * 1000),
    refresh_expires_at: Date.now() + (tokens.x_refresh_token_expires_in * 1000),
  });

  // Return HTML that closes the popup and notifies the opener
  return new Response(`<!DOCTYPE html><html><body><script>
    if (window.opener) { window.opener.postMessage({type:'qbo-connected'}, '*'); }
    window.close();
  </script><p>Connected! You can close this window.</p></body></html>`, {
    headers: { 'Content-Type': 'text/html' },
  });
}

async function handleStatus(env) {
  const tokens = await getTokens(env);
  if (!tokens) return json({ connected: false });

  return json({
    connected: true,
    realm_id: tokens.realm_id,
    expires_at: tokens.expires_at,
    refresh_expires_at: tokens.refresh_expires_at,
  });
}

async function handleDisconnect(env) {
  await env.QBO_TOKENS.delete('tokens');
  return json({ ok: true });
}

// ===== QBO API Handlers =====

async function handleCustomerSearch(url, env) {
  const q = url.searchParams.get('q') || '';
  const query = q
    ? `SELECT * FROM Customer WHERE DisplayName LIKE '%${q.replace(/'/g, "\\'")}%' MAXRESULTS 20`
    : 'SELECT * FROM Customer MAXRESULTS 50';

  const data = await qboRequest(env, `/query?query=${encodeURIComponent(query)}`);
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

  const invoiceData = {
    CustomerRef: { value: customerId },
    DueDate: dueDate || undefined,
    TxnDate: txnDate || undefined,
    DocNumber: docNumber || undefined,
    // Manual/pay-by-invoice customers only — no online payment buttons on
    // the emailed invoice.
    AllowIPNPayment: false,
    AllowOnlineACHPayment: false,
    AllowOnlineCreditCardPayment: false,
    Line: lineItems.map((item) => ({
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
  if (customerMemo) invoiceData.CustomerMemo = { value: customerMemo };

  const qs = requestId ? `?requestid=${encodeURIComponent(requestId)}` : '';
  const result = await qboRequest(env, `/invoice${qs}`, {
    method: 'POST',
    body: JSON.stringify(invoiceData),
  });

  return json(mapInvoice(result?.Invoice || {}));
}

async function handleItemSearch(url, env) {
  const q = url.searchParams.get('q') || '';
  const query = q
    ? `SELECT * FROM Item WHERE Name = '${q.replace(/'/g, "\\'")}' MAXRESULTS 20`
    : 'SELECT * FROM Item MAXRESULTS 50';

  const data = await qboRequest(env, `/query?query=${encodeURIComponent(query)}`);
  const items = data?.QueryResponse?.Item || [];

  return json(items.map(i => ({ id: i.Id, name: i.Name, active: i.Active, type: i.Type })));
}

async function handleInvoiceQuery(url, env) {
  const docNumber = url.searchParams.get('doc_number');
  if (!docNumber) return json({ error: 'doc_number required' }, 400);

  const query = `SELECT * FROM Invoice WHERE DocNumber = '${docNumber.replace(/'/g, "\\'")}'`;
  const data = await qboRequest(env, `/query?query=${encodeURIComponent(query)}`);
  const invoices = data?.QueryResponse?.Invoice || [];

  return json(invoices.map(mapInvoice));
}

async function handleReadInvoice(id, env) {
  const data = await qboRequest(env, `/invoice/${encodeURIComponent(id)}`);
  if (!data?.Invoice) return json({ error: 'Invoice not found' }, 404);
  return json(mapInvoice(data.Invoice));
}

async function handleSendInvoice(id, url, env) {
  const sendTo = url.searchParams.get('sendTo');
  const qs = sendTo ? `?sendTo=${encodeURIComponent(sendTo)}` : '';
  const data = await qboRequest(env, `/invoice/${encodeURIComponent(id)}/send${qs}`, { method: 'POST' });
  if (!data?.Invoice) return json({ error: 'Send did not return an invoice' }, 502);
  return json(mapInvoice(data.Invoice));
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
    lineCount: Array.isArray(inv.Line) ? inv.Line.length : 0,
  };
}

// ===== Token Management =====

async function storeTokens(env, tokens) {
  await env.QBO_TOKENS.put('tokens', JSON.stringify(tokens));
}

async function getTokens(env) {
  const raw = await env.QBO_TOKENS.get('tokens');
  if (!raw) return null;
  return JSON.parse(raw);
}

async function getValidAccessToken(env) {
  const tokens = await getTokens(env);
  if (!tokens) throw new Error('Not connected to QuickBooks');

  // If access token not expired, use it
  if (Date.now() < tokens.expires_at - 60000) {
    return { accessToken: tokens.access_token, realmId: tokens.realm_id };
  }

  // Refresh the token
  console.log('Refreshing QBO access token...');
  const res = await relayFetch(env, QBO_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + btoa(`${env.QBO_CLIENT_ID}:${env.QBO_CLIENT_SECRET}`),
      'Accept': 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error('Token refresh failed:', errText);
    // Clear tokens if refresh fails
    await env.QBO_TOKENS.delete('tokens');
    throw new Error('Token refresh failed - please reconnect');
  }

  const newTokens = await res.json();
  const updated = {
    access_token: newTokens.access_token,
    refresh_token: newTokens.refresh_token,
    realm_id: tokens.realm_id,
    expires_at: Date.now() + (newTokens.expires_in * 1000),
    refresh_expires_at: Date.now() + (newTokens.x_refresh_token_expires_in * 1000),
  };
  await storeTokens(env, updated);

  return { accessToken: updated.access_token, realmId: updated.realm_id };
}

async function qboRequest(env, path, options = {}) {
  const { accessToken, realmId } = await getValidAccessToken(env);
  const url = `${QBO_API_BASE}/${realmId}${path}`;

  const res = await relayFetch(env, url, {
    method: options.method || 'GET',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      ...options.headers,
    },
    body: options.body,
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`QBO API error (${res.status}):`, errText);
    throw new Error(`QBO API error ${res.status}: ${errText}`);
  }

  return res.json();
}

// ===== Helpers =====

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
