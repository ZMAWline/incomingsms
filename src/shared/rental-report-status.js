// INC-3 follow-up: normalize the ?status=… query param on the reports list
// endpoint into a PostgREST status filter fragment.
//
// The DB CHECK constraint on rental_reports.status only permits the literal
// values below. Resellers reach for friendlier aliases ("resolved", "open"),
// which we expand to status sets here. Anything else is rejected with a 400.
//
// See supabase/migrations/20260602_rental_reports.sql for the constraint.

const LITERAL_STATUSES = new Set([
  'received',
  'in_triage',
  'remediated',
  'unable_to_reproduce',
  'duplicate',
]);

const ALIASES = {
  open: ['received', 'in_triage'],
  resolved: ['remediated', 'unable_to_reproduce', 'duplicate'],
};

// Default applied when the caller omits ?status entirely. Preserved from the
// original handler behaviour: callers historically passed status=open and the
// docs/UI lead with that, so an empty filter would surprise integrators.
// Returning `null` here means "no filter" — keep that for the empty case;
// the handler decides what to default to.

/**
 * Normalize a raw `?status=…` value into a PostgREST filter fragment.
 *
 * @param {string|null|undefined} raw
 * @returns {{ ok: true, filter: string|null } | { ok: false, error: string, accepted: string[] }}
 *   - ok=true, filter=null  → no status filter (status=all, or unset)
 *   - ok=true, filter=string → append directly to the PostgREST query
 *   - ok=false → 400 with the accepted list
 */
export function buildStatusFilter(raw) {
  if (raw == null || raw === '') {
    // No param — preserve prior default (open). Callers may override by
    // passing status=all explicitly.
    return { ok: true, filter: '&status=in.(received,in_triage)' };
  }
  const value = String(raw).trim().toLowerCase();
  if (value === 'all') return { ok: true, filter: null };
  if (Object.prototype.hasOwnProperty.call(ALIASES, value)) {
    return { ok: true, filter: '&status=in.(' + ALIASES[value].join(',') + ')' };
  }
  if (LITERAL_STATUSES.has(value)) {
    return { ok: true, filter: '&status=eq.' + value };
  }
  return {
    ok: false,
    error: 'bad_request',
    accepted: ['open', 'resolved', 'all', ...LITERAL_STATUSES],
  };
}

export const ACCEPTED_STATUS_VALUES = ['open', 'resolved', 'all', ...LITERAL_STATUSES];
