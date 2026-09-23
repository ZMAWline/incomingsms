// =========================================================
// Supabase PostgREST helpers shared by every worker.
//
// Every call goes through supabaseFetch (bounded by FETCH_TIMEOUT_SUPABASE_MS)
// and authenticates with the service_role key. A non-2xx response throws a
// SupabaseError carrying the HTTP status and the raw response body; no helper
// ever returns an error object as data. A caller that wants to tolerate a
// failure catches it at the call site.
//
//   sbHeaders(env, extra)              auth + Accept headers, extra merged last
//   sbGet(env, path, opts)             rows array ([] on an empty body)
//     opts.single: true                first row or null
//     opts.count: 'exact'              { rows, count } from Content-Range
//   sbGetAll(env, path, opts)          every row, paging past the 1000-row cap
//   sbPost(env, path, body, opts)      parsed body, or null when empty
//   sbPatch(env, path, body, opts)     parsed body, or null when empty
//   sbDelete(env, path, opts)          parsed body, or null when empty
//   sbRpc(env, fn, args, opts)         parsed body, or null when empty
//
// opts.prefer sets the Prefer header (for example 'return=representation',
// 'return=minimal', 'resolution=merge-duplicates,return=minimal').
// opts.headers adds or overrides request headers.
// opts.raw: true returns the fetch Response untouched and never throws on a
//   non-2xx status. For callers that branch on res.ok / res.status themselves.
// opts.logRows: true logs how many rows a write touched
//   ("[DB] PATCH result: N rows updated"); implies Prefer: return=representation
//   unless opts.prefer is set.
// =========================================================

import { supabaseFetch } from './fetch-timeout.mjs';

export const PAGE_SIZE = 1000;

export class SupabaseError extends Error {
  constructor(method, status, body) {
    super(`Supabase ${method} failed ${status}: ${String(body).slice(0, 300)}`);
    this.name = 'SupabaseError';
    this.status = status;
    this.body = body;
  }
}

export function sbHeaders(env, extra) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    Accept: 'application/json',
    ...(extra || {}),
  };
}

const ROWS_VERB = { POST: 'inserted', PATCH: 'updated', DELETE: 'deleted' };

// Sends one PostgREST request and returns the fetch Response.
function send(env, method, path, body, opts = {}) {
  const extra = {};
  if (body !== undefined) extra['Content-Type'] = 'application/json';
  const prefer = opts.prefer || (opts.logRows ? 'return=representation' : undefined);
  if (prefer) extra.Prefer = prefer;
  const init = { method, headers: sbHeaders(env, { ...extra, ...(opts.headers || {}) }) };
  if (body !== undefined) init.body = JSON.stringify(body);
  return supabaseFetch(env, `${env.SUPABASE_URL}/rest/v1/${path}`, init);
}

// One PostgREST request. Returns { data, res }: data is the parsed JSON body,
// null when the body is empty. With opts.raw, returns the Response instead.
async function request(env, method, path, body, opts = {}) {
  const res = await send(env, method, path, body, opts);
  if (opts.raw) return res;
  const text = await res.text();
  if (!res.ok) throw new SupabaseError(method, res.status, text);
  if (!text.trim()) return { data: null, res };
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`Supabase ${method} JSON parse failed: ${String(e)}. Raw: ${text.slice(0, 300)}`);
  }
  if (opts.logRows && Array.isArray(data)) {
    console.log(`[DB] ${method} result: ${data.length} rows ${ROWS_VERB[method] || 'returned'}`);
  }
  return { data, res };
}

// Total row count from a `Content-Range: 0-9/123` header, null when absent.
function parseCount(res) {
  const m = (res.headers.get('content-range') || '').match(/\/(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}

export async function sbGet(env, path, opts = {}) {
  const prefer = opts.count ? `count=${opts.count}` : opts.prefer;
  if (opts.raw) return request(env, 'GET', path, undefined, { ...opts, prefer });
  const { data, res } = await request(env, 'GET', path, undefined, { ...opts, prefer });
  const rows = Array.isArray(data) ? data : data == null ? [] : data;
  if (opts.count) return { rows, count: parseCount(res) };
  if (opts.single) return Array.isArray(rows) ? rows[0] ?? null : rows;
  return rows;
}

// Every row matching `path`, fetched PAGE_SIZE rows at a time with
// limit/offset. `path` must not carry its own limit= or offset=.
export async function sbGetAll(env, path, opts = {}) {
  const pageSize = opts.pageSize || PAGE_SIZE;
  const sep = path.includes('?') ? '&' : '?';
  const out = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await sbGet(env, `${path}${sep}limit=${pageSize}&offset=${offset}`, { headers: opts.headers });
    if (!Array.isArray(page)) throw new Error(`Supabase GET returned a non-array for ${path.split('?')[0]}`);
    out.push(...page);
    if (page.length < pageSize) return out;
  }
}

// The write helpers return the parsed body (null when empty), or the Response
// itself with opts.raw.
function bodyOf(out, opts) {
  return opts?.raw ? out : out.data;
}

export async function sbPost(env, path, body, opts) {
  return bodyOf(await request(env, 'POST', path, body, opts), opts);
}

export async function sbPatch(env, path, body, opts) {
  return bodyOf(await request(env, 'PATCH', path, body, opts), opts);
}

export async function sbDelete(env, path, opts) {
  return bodyOf(await request(env, 'DELETE', path, undefined, opts), opts);
}

export async function sbRpc(env, fn, args, opts) {
  return bodyOf(await request(env, 'POST', `rpc/${fn}`, args || {}, opts), opts);
}
