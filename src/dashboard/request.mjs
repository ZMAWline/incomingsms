// @ts-check
import { SupabaseError as RestError } from '../shared/supabase-rest.mjs';

// ── Request values bound for a PostgREST URL ────────────────────────────────
// A PostgREST filter is plain query-string text, so a raw request value such
// as "active&select=*" or "1)or(id.gt.0" would add filters, widen the columns
// returned, or pull in embedded tables. Ids must be plain positive whole
// numbers, values from a known set are allow-listed, and any other free text
// goes through encodeURIComponent.

// Returns the id as a number, or null unless the value is a positive whole
// number (a JSON number or a string of digits). "1;drop", "-1", "1.5", "abc",
// "" and "01" are all null.
/** @param {unknown} value @returns {number | null} */
export function parsePositiveInt(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

// Allowed values, copied from the table CHECK constraints.
export const SIM_STATUSES = ['pending', 'provisioning', 'active', 'suspended', 'canceled', 'error', 'data_mismatch', 'helix_timeout', 'rotation_failed'];

export const SYSTEM_ERROR_STATUSES = ['open', 'acknowledged', 'resolved'];

export const ACTIVATION_ITEM_STATUSES = ['pending', 'queued', 'processing', 'done', 'failed', 'retry_needed', 'skipped'];

export const LEDGER_VENDORS = ['wing_iot', 'atomic', 'helix', 'teltik'];

export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @param {Record<string, string>} corsHeaders @param {string} error */
export function badRequest(corsHeaders, error) {
  return new Response(JSON.stringify({ error }), {
    status: 400,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

// Thrown when Supabase answers non-2xx, so its error object is never passed
// on as if it were data. errorResponse turns it into a 502.
export class SupabaseError extends Error {
  /** @param {number} status @param {string} detail */
  constructor(status, detail) {
    super(`Supabase query failed (${status})`);
    this.status = status;
    this.detail = detail;
  }
}

/** @param {Response} res */
export async function supabaseJson(res) {
  if (!res.ok) throw new SupabaseError(res.status, await res.text().catch(() => ''));
  return res.json();
}

// Catch-block response: 502 with the Supabase error for a failed query,
// 500 for anything else.
/** @param {unknown} error @param {Record<string, string>} corsHeaders */
export function errorResponse(error, corsHeaders) {
  const upstream = error instanceof SupabaseError || error instanceof RestError;
  const body = upstream ? { error: error.message, detail: error instanceof SupabaseError ? error.detail : error.body } : { error: String(error) };
  return new Response(JSON.stringify(body), {
    status: upstream ? 502 : 500,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}
