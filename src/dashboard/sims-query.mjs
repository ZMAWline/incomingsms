// Server-side paging, filtering and sorting for the SIMs table.
//
// GET /api/sims used to return every SIM and let the browser filter and sort.
// This module turns the SIMs table's state — toolbar selections, search box,
// per-column filters, sort and page — into one PostgREST query on the
// `sims_dashboard` view (supabase/migrations/20260922_sims_paging_indexes.sql).
//
// Every filter becomes a condition in a single `and=(...)` logic tree, with
// each value double-quoted, so no request value can add a parameter or reshape
// the tree.
//
// Eight columns are not in the view: SMS count and last SMS, and the six
// Teltik hosting-port fields. They come from the get_sms_counts_24h and
// get_hosting_port_status_summary RPCs. A filter or sort on one of them is
// "derived": the handler fetches the ids matching every other condition,
// computes those fields for them, then filters, sorts and pages in the Worker.
// Without one, the database pages and only the page's SIMs hit the RPCs.
//
// Filter semantics mirror simFilterMatches() in public/index.html, including
// "blank never matches a comparison" and the computed yes/no columns.

export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 500;
const MAX_FILTERS = 40;
const MAX_ENUM_VALUES = 500;
const MAX_TEXT = 200;
const MAX_SEARCH_TERMS = 500;
// Up to this many search terms, each is a substring match across every text
// column, as the browser did. Beyond it (a pasted list of ICCIDs or numbers)
// each term is matched only against the identifier columns its shape fits, to
// keep the query URL short.
const SUBSTRING_SEARCH_TERMS = 20;

// type: enum | number | date | text | bool. `column` is the view column.
// `derived` columns are computed from RPCs in the Worker; `computed` ones are a
// yes/no judgement expressed as a condition tree (see computedCondition).
export const SIMS_COLUMNS = {
  id:                        { type: 'number', column: 'id' },
  gateway_code:              { type: 'enum',   column: 'gateway_code' },
  port:                      { type: 'enum',   column: 'port' },
  iccid:                     { type: 'text',   column: 'iccid' },
  phone_number:              { type: 'text',   column: 'phone_number' },
  blimei:                    { type: 'text',   column: 'imei' },
  msisdn:                    { type: 'text',   column: 'msisdn' },
  status:                    { type: 'enum',   column: 'status' },
  vendor:                    { type: 'enum',   column: 'vendor' },
  verification_status:       { type: 'enum',   column: 'verification_status' },
  hosting_port_state:        { type: 'enum',   derived: true },
  offline_state:             { type: 'enum',   column: 'offline_state' },
  offline_since:             { type: 'date',   column: 'offline_since' },
  hosting_port_source:       { type: 'enum',   derived: true },
  hosting_port_checked_at:   { type: 'date',   derived: true },
  hosting_port_online_24h:   { type: 'number', derived: true },
  hosting_port_checks_24h:   { type: 'number', derived: true },
  reseller_name:             { type: 'enum',   column: 'reseller_name' },
  sms_count:                 { type: 'number', derived: true },
  last_sms_received:         { type: 'date',   derived: true },
  last_rotation_at:          { type: 'date',   column: 'last_rotation_at' },
  last_mdn_rotated_at:       { type: 'date',   column: 'last_mdn_rotated_at' },
  activated_at:              { type: 'date',   column: 'activated_at' },
  last_notified_at:          { type: 'date',   column: 'last_notified_at' },
  carrier:                   { type: 'enum',   column: 'carrier' },
  gateway_host:              { type: 'enum',   column: 'gateway_host' },
  rotation_interval_hours:   { type: 'number', column: 'rotation_interval_hours' },
  rotation_eligible:         { type: 'bool',   column: 'rotation_eligible' },
  port_in_pending:           { type: 'bool',   column: 'port_in_pending' },
  atomic_portin_status_code: { type: 'enum',   column: 'atomic_portin_status_code' },
  last_activation_error:     { type: 'text',   column: 'last_activation_error' },
  notify_stale:              { type: 'bool',   computed: true },
  not_rotated_today:         { type: 'bool',   computed: true },
  portin_failed:             { type: 'bool',   computed: true },
  stuck_provisioning:        { type: 'bool',   computed: true },
  no_sms_12h:                { type: 'bool',   derived: true },
  no_reseller:               { type: 'bool',   computed: true },
};

const OPS = {
  enum:   ['in', 'not_in', 'blank', 'not_blank'],
  number: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'blank', 'not_blank'],
  date:   ['within_h', 'older_h', 'after', 'before', 'between', 'blank', 'not_blank'],
  text:   ['contains', 'not_contains', 'eq', 'starts', 'blank', 'not_blank'],
  bool:   ['is_true', 'is_false'],
};

// Text-typed view columns: a blank is NULL or ''. Numbers, dates and booleans
// can only be NULL, and comparing them to '' is a Postgres error.
const TEXT_TYPES = new Set(['enum', 'text']);

const SEARCH_TEXT_COLUMNS = [
  'iccid', 'imei', 'msisdn', 'phone_number', 'status', 'vendor', 'port',
  'gateway_code', 'gateway_name', 'reseller_name', 'carrier', 'gateway_host',
  'last_activation_error', 'atomic_portin_status_code', 'atomic_portin_description',
  'offline_state', 'verification_status', 'rotation_pause_reason',
];
const SEARCH_NUMBER_COLUMNS = ['id', 'mobility_subscription_id', 'reseller_id', 'gateway_id'];

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;

// ── PostgREST logic-tree pieces ────────────────────────────────────────────

// A double-quoted logic-tree value. Inside quotes PostgREST reads `,` `(` `)`
// and `.` literally; a backslash escapes `"` and `\`.
export function quote(value) {
  return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// LIKE treats % and _ as wildcards; escape them so a typed "_" is a literal.
function likeEscape(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function negate(cond) {
  if (cond.startsWith('and(') || cond.startsWith('or(')) return 'not.' + cond;
  const dot = cond.indexOf('.');
  return cond.slice(0, dot) + '.not.' + cond.slice(dot + 1);
}

// NULL-safe "col < t": false rather than NULL when col is NULL, so the
// condition can be negated without NULL swallowing the row.
function before(col, t) {
  return `and(${col}.not.is.null,${col}.lt.${quote(t)})`;
}

function blankCond(col, type) {
  return TEXT_TYPES.has(type) ? `or(${col}.is.null,${col}.eq."")` : `${col}.is.null`;
}

function notBlankCond(col, type) {
  return TEXT_TYPES.has(type) ? `and(${col}.not.is.null,${col}.neq."")` : `${col}.not.is.null`;
}

function hoursAgo(now, hours) {
  return new Date(now.getTime() - hours * 3600000).toISOString();
}

// The judgement columns, as the browser computes them (simNotNotified,
// simNotRotatedToday, simPortInFailed, simStuckProvisioning1h, "no reseller").
function computedCondition(key, now) {
  switch (key) {
    case 'notify_stale':
      // Active SIMs whose last number.online is missing or older than the
      // vendor's window: 48 h for Teltik, 24 h for everything else.
      return `and(status.eq.active,or(last_notified_at.is.null,`
        + `and(vendor.eq.teltik,${before('last_notified_at', hoursAgo(now, 48))}),`
        + `and(vendor.neq.teltik,${before('last_notified_at', hoursAgo(now, 24))})))`;
    case 'not_rotated_today':
      return `or(last_mdn_rotated_at.is.null,last_mdn_rotated_at.lt.${quote(now.toISOString().slice(0, 10) + 'T00:00:00Z')})`;
    case 'portin_failed':
      return 'and(atomic_portin_status_code.not.is.null,atomic_portin_status_code.neq."",atomic_portin_status_code.neq."00")';
    case 'stuck_provisioning': {
      const t = hoursAgo(now, 1);
      return `and(status.eq.provisioning,or(${before('activated_at', t)},and(activated_at.is.null,${before('created_at', t)})))`;
    }
    case 'no_reseller':
      return 'or(reseller_id.is.null)';
  }
  throw new Error('unknown computed column ' + key);
}

// One per-column filter → one condition. Values are already validated.
function filterCondition(f, now) {
  const def = SIMS_COLUMNS[f.col];
  if (def.computed) {
    const cond = computedCondition(f.col, now);
    return f.op === 'is_true' ? cond : negate(cond);
  }
  const col = def.column;
  if (f.op === 'blank') return blankCond(col, def.type);
  if (f.op === 'not_blank') return notBlankCond(col, def.type);

  switch (def.type) {
    case 'bool':
      return `${col}.is.${f.op === 'is_true' ? 'true' : 'false'}`;
    case 'enum': {
      const list = `(${f.value.map(quote).join(',')})`;
      if (f.op === 'in') return `${col}.in.${list}`;
      return `or(${col}.is.null,${col}.eq."",${col}.not.in.${list})`;
    }
    case 'number': {
      if (f.op === 'between') {
        const lo = Math.min(f.value, f.value2), hi = Math.max(f.value, f.value2);
        return `and(${col}.gte.${lo},${col}.lte.${hi})`;
      }
      const pgOp = { eq: 'eq', ne: 'neq', gt: 'gt', gte: 'gte', lt: 'lt', lte: 'lte' }[f.op];
      return `${col}.${pgOp}.${f.value}`;
    }
    case 'date': {
      if (f.op === 'within_h') return `${col}.gte.${quote(hoursAgo(now, f.value))}`;
      if (f.op === 'older_h') return `${col}.lt.${quote(hoursAgo(now, f.value))}`;
      if (f.op === 'after') return `${col}.gte.${quote(f.value)}`;
      if (f.op === 'before') return `${col}.lte.${quote(f.value)}`;
      const parts = [];
      if (f.value) parts.push(`${col}.gte.${quote(f.value)}`);
      if (f.value2) parts.push(`${col}.lte.${quote(f.value2)}`);
      return `and(${parts.join(',')})`;
    }
    case 'text': {
      const v = likeEscape(f.value);
      if (f.op === 'contains') return `${col}.ilike.${quote('*' + v + '*')}`;
      if (f.op === 'not_contains') return `and(${col}.neq."",${col}.not.ilike.${quote('*' + v + '*')})`;
      if (f.op === 'eq') return `${col}.ilike.${quote(v)}`;
      return `${col}.ilike.${quote(v + '*')}`;
    }
  }
  throw new Error('unhandled filter ' + f.col + ' ' + f.op);
}

// Same term splitting as matchesSearch() in public/index.html: commas,
// semicolons and line breaks separate terms, and a space-separated list of
// long numbers (a mobile paste) is a list rather than one phrase.
export function splitSimsSearch(query) {
  let terms = query.split(/[,;\n\r\t]+/).map(t => t.trim().toLowerCase()).filter(Boolean);
  const wsParts = query.split(/[\s,;]+/).map(t => t.trim()).filter(Boolean);
  if (wsParts.length > terms.length && wsParts.every(p => /^\+?\d{5,}$/.test(p))) {
    terms = wsParts.map(p => p.toLowerCase());
  }
  return [...new Set(terms)];
}

// 10-15 digit terms are phone numbers: match with and without the leading 1.
function phoneVariants(digits) {
  if (digits.length < 10 || digits.length > 15) return [];
  const out = [digits];
  if (digits.length === 11 && digits.charAt(0) === '1') out.push(digits.slice(1));
  else if (digits.length === 10) out.push('1' + digits);
  return out;
}

function searchCondition(terms) {
  const preds = [];
  if (terms.length <= SUBSTRING_SEARCH_TERMS) {
    for (const term of terms) {
      const pattern = quote('*' + likeEscape(term) + '*');
      for (const col of SEARCH_TEXT_COLUMNS) preds.push(`${col}.ilike.${pattern}`);
      if (/^[0-9]+$/.test(term) && Number.isSafeInteger(Number(term))) {
        for (const col of SEARCH_NUMBER_COLUMNS) preds.push(`${col}.eq.${Number(term)}`);
      }
      const digits = term.replace(/\D/g, '');
      for (const v of phoneVariants(digits)) {
        if (v === term) continue;
        const p = quote('*' + v + '*');
        preds.push(`phone_number.ilike.${p}`, `msisdn.ilike.${p}`);
      }
    }
    return `or(${preds.join(',')})`;
  }

  // A pasted list: route each term to the identifier columns its shape fits.
  const ids = [], longNums = [], phones = [], other = [];
  for (const term of terms) {
    const digits = term.replace(/\D/g, '');
    if (/^[0-9]+$/.test(term) && term.length <= 9) ids.push(Number(term));
    else if (digits.length >= 10 && digits.length <= 11 && /^[+\d\s().-]+$/.test(term)) phones.push(...phoneVariants(digits));
    else if (/^[0-9]+$/.test(term)) longNums.push(term);
    else other.push(term);
  }
  const anyLike = (values) => `{${values.map(v => quote('*' + likeEscape(v) + '*')).join(',')}}`;
  if (ids.length) preds.push(`id.in.(${ids.join(',')})`);
  if (longNums.length) {
    const set = anyLike(longNums);
    preds.push(`iccid.ilike(any).${set}`, `imei.ilike(any).${set}`, `msisdn.ilike(any).${set}`);
  }
  if (phones.length) {
    const set = anyLike(phones);
    preds.push(`phone_number.ilike(any).${set}`, `msisdn.ilike(any).${set}`);
  }
  if (other.length) {
    const set = anyLike(other);
    for (const col of ['iccid', 'phone_number', 'msisdn', 'imei', 'reseller_name']) preds.push(`${col}.ilike(any).${set}`);
  }
  return `or(${preds.join(',')})`;
}

// ── Request parsing ────────────────────────────────────────────────────────

function listParam(params, name) {
  const raw = params.get(name);
  if (raw == null || raw === '') return [];
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

function clampInt(raw, fallback, min, max) {
  const n = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function finiteNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isInstant(v) {
  return typeof v === 'string' && ISO_INSTANT_RE.test(v) && Number.isFinite(Date.parse(v));
}

// Validates one { col, op, value, value2 } filter from the browser. Returns
// the normalized filter, or a string saying what is wrong.
function normalizeFilter(raw) {
  if (!raw || typeof raw !== 'object') return 'each filter must be an object';
  const def = SIMS_COLUMNS[raw.col];
  if (!def) return 'unknown filter column: ' + String(raw.col).slice(0, 60);
  if (!OPS[def.type].includes(raw.op)) return `operator ${String(raw.op).slice(0, 30)} is not valid for ${raw.col}`;
  const f = { col: raw.col, op: raw.op };
  if (raw.op === 'blank' || raw.op === 'not_blank' || def.type === 'bool') return f;

  switch (def.type) {
    case 'enum': {
      if (!Array.isArray(raw.value) || !raw.value.length || raw.value.length > MAX_ENUM_VALUES) {
        return `${raw.col} needs 1-${MAX_ENUM_VALUES} values`;
      }
      if (raw.value.some(v => typeof v !== 'string' || v.length > MAX_TEXT)) return `${raw.col} values must be short strings`;
      f.value = raw.value;
      return f;
    }
    case 'number': {
      f.value = finiteNumber(raw.value);
      if (f.value == null) return `${raw.col} needs a number`;
      if (raw.op === 'between') {
        f.value2 = finiteNumber(raw.value2);
        if (f.value2 == null) return `${raw.col} between needs two numbers`;
      }
      return f;
    }
    case 'date': {
      if (raw.op === 'within_h' || raw.op === 'older_h') {
        f.value = finiteNumber(raw.value);
        if (f.value == null || f.value < 0 || f.value > 1e6) return `${raw.col} needs a number of hours`;
        return f;
      }
      if (raw.op === 'between') {
        f.value = raw.value || '';
        f.value2 = raw.value2 || '';
        if ((f.value && !isInstant(f.value)) || (f.value2 && !isInstant(f.value2)) || (!f.value && !f.value2)) {
          return `${raw.col} between needs ISO timestamps`;
        }
        return f;
      }
      if (!isInstant(raw.value)) return `${raw.col} needs an ISO timestamp`;
      f.value = raw.value;
      return f;
    }
    case 'text': {
      if (typeof raw.value !== 'string' || raw.value.length > MAX_TEXT) return `${raw.col} needs text up to ${MAX_TEXT} characters`;
      // An empty needle matches every non-blank row, as in the browser.
      if (!raw.value.trim()) return { col: raw.col, op: 'not_blank' };
      f.value = raw.value.trim();
      return f;
    }
  }
  return 'unsupported filter';
}

// Parses GET /api/sims (paged) query parameters.
//
//   page, page_size        clamped to >= 1 and 1..MAX_PAGE_SIZE
//   sort, dir              sort must be a SIMs column; dir asc | desc
//   status                 comma list from `statuses`; empty hides cancelled
//                          unless include_cancelled=1
//   reseller_ids           comma list of reseller ids and/or `none`
//   gateways, vendors      comma lists (vendors from `vendors`)
//   activated_from/_to     YYYY-MM-DD, inclusive, UTC days
//   search                 free text or a pasted list
//   filters                JSON array of { col, op, value, value2 }
//
// Returns { error } or the parsed request.
export function parseSimsPageRequest(params, { statuses, vendors, now = new Date() }) {
  const page = clampInt(params.get('page'), 1, 1, 1e6);
  const pageSize = clampInt(params.get('page_size'), DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);

  const sortKey = params.get('sort') || 'id';
  const sortDef = SIMS_COLUMNS[sortKey];
  if (!sortDef || sortDef.computed) return { error: 'Invalid sort column: ' + sortKey.slice(0, 60) };
  const dir = params.get('dir') || 'desc';
  if (dir !== 'asc' && dir !== 'desc') return { error: 'dir must be asc or desc' };

  const conditions = [];

  const statusList = listParam(params, 'status');
  const badStatus = statusList.find(s => !statuses.includes(s));
  if (badStatus) return { error: 'Invalid status. Valid: ' + statuses.join(', ') };
  if (statusList.length) conditions.push(`status.in.(${statusList.map(quote).join(',')})`);
  else if (params.get('include_cancelled') !== '1') conditions.push('status.neq.canceled');

  const resellerRaw = listParam(params, 'reseller_ids');
  const resellerIds = [];
  let resellerNone = false;
  for (const r of resellerRaw) {
    if (r === 'none') { resellerNone = true; continue; }
    if (!/^[1-9][0-9]{0,15}$/.test(r)) return { error: 'reseller_ids must be positive whole numbers or none' };
    resellerIds.push(Number(r));
  }
  if (resellerIds.length && resellerNone) conditions.push(`or(reseller_id.is.null,reseller_id.in.(${resellerIds.join(',')}))`);
  else if (resellerIds.length) conditions.push(`reseller_id.in.(${resellerIds.join(',')})`);
  else if (resellerNone) conditions.push('reseller_id.is.null');

  const gateways = listParam(params, 'gateways');
  if (gateways.some(g => g.length > MAX_TEXT)) return { error: 'gateway codes must be short' };
  if (gateways.length) conditions.push(`gateway_code.in.(${gateways.map(quote).join(',')})`);

  const vendorList = listParam(params, 'vendors');
  if (vendorList.some(v => !vendors.includes(v))) return { error: 'Invalid vendor. Valid: ' + vendors.join(', ') };
  if (vendorList.length) conditions.push(`vendor.in.(${vendorList.map(quote).join(',')})`);

  const from = params.get('activated_from');
  const to = params.get('activated_to');
  if (from && !ISO_DATE_RE.test(from)) return { error: 'activated_from must be YYYY-MM-DD' };
  if (to && !ISO_DATE_RE.test(to)) return { error: 'activated_to must be YYYY-MM-DD' };
  if (from) conditions.push(`activated_at.gte.${quote(from + 'T00:00:00Z')}`);
  if (to) conditions.push(`activated_at.lte.${quote(to + 'T23:59:59.999Z')}`);

  const search = (params.get('search') || '').trim();
  if (search) {
    const terms = splitSimsSearch(search);
    if (terms.length > MAX_SEARCH_TERMS) return { error: `search has more than ${MAX_SEARCH_TERMS} terms` };
    if (terms.some(t => t.length > MAX_TEXT)) return { error: `search terms must be up to ${MAX_TEXT} characters` };
    if (terms.length) conditions.push(searchCondition(terms));
  }

  let rawFilters = [];
  const filtersParam = params.get('filters');
  if (filtersParam) {
    try { rawFilters = JSON.parse(filtersParam); } catch { return { error: 'filters must be JSON' }; }
    if (!Array.isArray(rawFilters)) return { error: 'filters must be a JSON array' };
    if (rawFilters.length > MAX_FILTERS) return { error: `at most ${MAX_FILTERS} filters` };
  }
  const derivedFilters = [];
  for (const raw of rawFilters) {
    const f = normalizeFilter(raw);
    if (typeof f === 'string') return { error: f };
    if (SIMS_COLUMNS[f.col].derived) derivedFilters.push(f);
    else conditions.push(filterCondition(f, now));
  }

  return {
    page,
    pageSize,
    sort: { key: sortKey, column: sortDef.column || null, derived: !!sortDef.derived },
    dir,
    conditions,
    derivedFilters,
    now,
  };
}

// `&and=(...)`, URL-encoded, or '' when there is nothing to filter on.
export function filterParam(conditions) {
  if (!conditions.length) return '';
  return '&and=' + encodeURIComponent('(' + conditions.join(',') + ')');
}

// Blanks last in both directions, as the browser sorted; id breaks ties so
// paging is stable. A derived sort is done in the Worker, so the database
// just returns id order for it.
export function orderParam(req) {
  if (req.sort.derived) return 'order=id.desc';
  if (req.sort.column === 'id') return `order=id.${req.dir}`;
  return `order=${req.sort.column}.${req.dir}.nullslast,id.desc`;
}

// PostgREST's Content-Range: "0-99/5512", or "*/0" for an empty result.
export function parseContentRangeTotal(header) {
  const total = Number.parseInt(String(header || '').split('/')[1], 10);
  return Number.isFinite(total) && total >= 0 ? total : null;
}

// ── Derived columns (SMS and hosting-port stats) ───────────────────────────

function derivedValue(row, key, now) {
  if (key === 'no_sms_12h') {
    return !row.last_sms_received || new Date(row.last_sms_received).getTime() < now.getTime() - 12 * 3600000;
  }
  return row[key];
}

// simFilterMatches() from public/index.html, for the derived columns.
export function matchesDerivedFilter(row, f, now) {
  const def = SIMS_COLUMNS[f.col];
  const raw = derivedValue(row, f.col, now);
  const isBlank = raw == null || raw === '';
  if (f.op === 'blank') return isBlank;
  if (f.op === 'not_blank') return !isBlank;
  if (f.op === 'is_true') return raw === true;
  if (f.op === 'is_false') return raw === false;
  if (isBlank) return f.op === 'not_in';

  if (def.type === 'enum') {
    const hit = f.value.includes(String(raw));
    return f.op === 'not_in' ? !hit : hit;
  }
  if (def.type === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n)) return false;
    const a = f.value, b = f.value2;
    switch (f.op) {
      case 'eq': return n === a;
      case 'ne': return n !== a;
      case 'gt': return n > a;
      case 'gte': return n >= a;
      case 'lt': return n < a;
      case 'lte': return n <= a;
      case 'between': return n >= Math.min(a, b) && n <= Math.max(a, b);
    }
    return true;
  }
  // date
  const t = new Date(raw).getTime();
  if (!Number.isFinite(t)) return false;
  if (f.op === 'within_h') return t >= now.getTime() - f.value * 3600000;
  if (f.op === 'older_h') return t < now.getTime() - f.value * 3600000;
  if (f.op === 'after') return t >= Date.parse(f.value);
  if (f.op === 'before') return t <= Date.parse(f.value);
  if (f.value && t < Date.parse(f.value)) return false;
  if (f.value2 && t > Date.parse(f.value2)) return false;
  return true;
}

// Sorts rows on a derived column: blanks last, numbers and dates by value,
// id descending on ties.
export function sortByDerived(rows, key, dir, now) {
  const mul = dir === 'asc' ? 1 : -1;
  const type = SIMS_COLUMNS[key].type;
  const val = (r) => {
    const v = derivedValue(r, key, now);
    if (v == null || v === '') return null;
    if (type === 'date') return new Date(v).getTime();
    if (type === 'number') return Number(v);
    if (type === 'bool') return v ? 1 : 0;
    return String(v).toLowerCase();
  };
  return [...rows].sort((a, b) => {
    const va = val(a), vb = val(b);
    if (va == null && vb == null) return b.id - a.id;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (va < vb) return -1 * mul;
    if (va > vb) return 1 * mul;
    return b.id - a.id;
  });
}
