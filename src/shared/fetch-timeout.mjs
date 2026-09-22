// =========================================================
// Bounded outbound fetch for every worker.
//
// A carrier, Supabase, or webhook call that never answers holds the Worker
// invocation open until the platform kills it: the batch never finishes, the
// progress/failure write never runs, and nothing is retried. Every outbound
// call goes through fetchWithTimeout so a hang becomes a normal thrown Error
// that the caller's existing catch path records.
//
// Defaults per call class, each overridable per worker via an env var:
//   carrier  (ATOMIC, Teltik, Helix, Wing, via relay)  FETCH_TIMEOUT_CARRIER_MS
//   supabase (PostgREST / RPC)                          FETCH_TIMEOUT_SUPABASE_MS
//   webhook  (reseller webhooks, Slack, email APIs)     FETCH_TIMEOUT_WEBHOOK_MS
// =========================================================

export const CARRIER_TIMEOUT_MS = 45_000;
export const SUPABASE_TIMEOUT_MS = 15_000;
export const WEBHOOK_TIMEOUT_MS = 10_000;

const DEFAULTS = {
  CARRIER: CARRIER_TIMEOUT_MS,
  SUPABASE: SUPABASE_TIMEOUT_MS,
  WEBHOOK: WEBHOOK_TIMEOUT_MS,
};

// Timeout for a call class: env.FETCH_TIMEOUT_<KIND>_MS when it is a positive
// number, otherwise the default above.
export function timeoutFor(env, kind) {
  const override = Number(env && env['FETCH_TIMEOUT_' + kind + '_MS']);
  return override > 0 ? override : DEFAULTS[kind];
}

// "GET host/path" for error messages. Relayed URLs (<RELAY_URL>/https://...)
// describe the real target. Query strings never appear: they can carry API
// keys (Teltik apikey=). Webhook paths are dropped too: a Slack webhook path
// is itself the secret.
function describe(url, init, withPath) {
  const method = (init && init.method) || 'GET';
  try {
    let u = new URL(String(url));
    const relayed = u.pathname.match(/^\/(https?:\/\/.*)$/);
    if (relayed) u = new URL(relayed[1]);
    return method + ' ' + u.host + (withPath ? u.pathname : '');
  } catch {
    return method + ' request';
  }
}

// fetch() that rejects with `<label> timeout after <ms>ms` when no response
// headers arrive within timeoutMs. The timer is cleared once headers arrive,
// so it bounds the connect-and-respond wait, not a slow body read.
export async function fetchWithTimeout(url, init = {}, { timeoutMs, label } = {}) {
  const ctrl = new AbortController();
  const message = (label || describe(url, init, false)) + ' timeout after ' + timeoutMs + 'ms';
  const timer = setTimeout(() => ctrl.abort(new Error(message)), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (err) {
    if (ctrl.signal.aborted) throw new Error(message, { cause: err });
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function supabaseFetch(env, url, init) {
  return fetchWithTimeout(url, init, {
    timeoutMs: timeoutFor(env, 'SUPABASE'),
    label: 'Supabase ' + describe(url, init, true),
  });
}

export function carrierFetch(env, url, init) {
  return fetchWithTimeout(url, init, {
    timeoutMs: timeoutFor(env, 'CARRIER'),
    label: 'carrier ' + describe(url, init, true),
  });
}

export function webhookFetch(env, url, init) {
  return fetchWithTimeout(url, init, {
    timeoutMs: timeoutFor(env, 'WEBHOOK'),
    label: 'webhook ' + describe(url, init, false),
  });
}
