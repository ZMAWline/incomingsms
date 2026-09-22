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

// One PostgREST request. Returns { data, res }: data is the parsed JSON body,
// null when the body is empty.
async function request(env, method, path, body, opts = {}) {
  const extra = {};
  if (body !== undefined) extra['Content-Type'] = 'application/json';
  if (opts.prefer) extra.Prefer = opts.prefer;
  const init = { method, headers: sbHeaders(env, { ...extra, ...(opts.headers || {}) }) };
  if (body !== undefined) init.body = JSON.stringify(body);

  const res = await supabaseFetch(env, `${env.SUPABASE_URL}/rest/v1/${path}`, init);
  const text = await res.text();
  if (!res.ok) throw new SupabaseError(method, res.status, text);
  if (!text.trim()) return { data: null, res };
  try {
    return { data: JSON.parse(text), res };
  } catch (e) {
    throw new Error(`Supabase ${method} JSON parse failed: ${String(e)}. Raw: ${text.slice(0, 300)}`);
  }
}

// Total row count from a `Content-Range: 0-9/123` header, null when absent.
function parseCount(res) {
  const m = (res.headers.get('content-range') || '').match(/\/(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}

export async function sbGet(env, path, opts = {}) {
  const prefer = opts.count ? `count=${opts.count}` : opts.prefer;
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

export async function sbPost(env, path, body, opts) {
  return (await request(env, 'POST', path, body, opts)).data;
}

export async function sbPatch(env, path, body, opts) {
  return (await request(env, 'PATCH', path, body, opts)).data;
}

export async function sbDelete(env, path, opts) {
  return (await request(env, 'DELETE', path, undefined, opts)).data;
}

export async function sbRpc(env, fn, args, opts) {
  return (await request(env, 'POST', `rpc/${fn}`, args || {}, opts)).data;
}
