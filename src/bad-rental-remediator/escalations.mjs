// =========================================================
// INC-22 / INC-16f — Operator escalations (§H.3) + vendor batch ticket (§H.4)
//
// Plan v4 §H.3 batches operator escalations — NEVER free-form Telegram/Slack.
// One notice per (vendor, failure_type, tick) batch. So 12 H4-suspended Helix
// SIMs in a single tick collapse into one notice with 12 line items, not 12.
//
// SINK (retargeted 2026-08-06, t_6c6abd40): the batch notice lands in
// IncomingSMS-owned surfaces only — `operator_escalations` is the durable
// queue/audit record, and `pending_review_items` is the operator inbox the
// dashboard already renders (same widget the rotation review uses). The
// project migrated off Paperclip on 2026-07-02 (PROJECT.md) to the
// `incomingsms` kanban board, so there is no external issue API to POST to
// and NO external credential is required to deliver an escalation. Rows must
// never sit queued waiting for a sink that no longer exists.
//
// Plan v4 §H.4 vendor-batched ticket (still toggle-gated, default off).
// Trigger: ≥5 SIMs in same vendor account in terminal-suspended/barred state
// in 24h AND per-carrier toggle on (KV `vendor_batch_ticket_<vendor>`='true').
//
// Pure functions for batching, table-driven failure-type catalogue, and the
// DB-backed reserve → deliver path.
//
// Identifier surface:
//   - operator-facing → ICCID OK (operators see it in the dashboard).
//   - reseller-facing → never; we never emit reseller-facing messages here.
//   - No secrets in line items.
// =========================================================

// §H.3 — the 14 enumerated failure types + 'generic' fallback.
export const ESCALATION_FAILURE_TYPES = Object.freeze([
  'verify_send_failed',
  'verify_receive_timeout',
  'vendor_active_no_sms',
  'vendor_iccid_not_found',
  'imei_wrong_type',
  'imei_drift_vendor',
  'vendor_cancelled_active_rental',
  'wing_w7_dialable_retry_failed',
  'helix_unsuspend_failed',
  'atomic_restore_failed',
  'teltik_reset_failed',
  'teltik_gateway_port_offline',
  'teltik_forward_url_misconfigured',
  'unable_to_reproduce_recommendation',
  'vendor_read_failed',
  'vendor_mdn_drift',
  // R1 — distinct TH2/S5 exhaustion reasons (mirrors the vendor classifier's
  // A10/W9/H9/T11 unable_to_reproduce pattern, but naming the specific
  // component that kept failing to read).
  'teltik_host_port_read_failed',
  'gateway_port_offline_unresolved',
  // R3 — unseated Teltik line (gateway_id:0/port:null); reset-port can never
  // fix this, so it is distinct from teltik_gateway_port_offline.
  'teltik_line_not_seated',
  // R6 — a PreResolveGate action succeeded but could not be SMS-verified
  // because the global outbound-SMS kill switch is on.
  'verify_sms_disabled',
  // R5 — reprocessing-loop backstop escalation.
  'reprocessing_loop',
  'generic',
]);

const FAILURE_TYPE_SET = new Set(ESCALATION_FAILURE_TYPES);

// Coerce a free-form classifier escalation_reason or executor failure to one
// of the enumerated §H.3 failure types. Anything we cannot map falls to
// 'generic' so it still batches predictably.
export function normalizeFailureType(reason) {
  if (!reason) return 'generic';
  const r = String(reason).toLowerCase();
  if (FAILURE_TYPE_SET.has(r)) return r;
  // Common aliases from classifier / verify-runner / executors.
  if (r === 'wing_not_activated' || r === 'w7_failed') return 'wing_w7_dialable_retry_failed';
  if (r.startsWith('helix_unsuspend')) return 'helix_unsuspend_failed';
  if (r.startsWith('atomic_restore')) return 'atomic_restore_failed';
  if (r.startsWith('teltik_reset')) return 'teltik_reset_failed';
  if (r === 'teltik_gateway_port_offline' || r.includes('gateway_port_offline')) return 'teltik_gateway_port_offline';
  if (r.startsWith('teltik_forward')) return 'teltik_forward_url_misconfigured';
  if (r === 'insufficient_evidence' || r === 'insufficient_evidence_no_vendor'
      || r === 'insufficient_evidence_unknown_vendor') return 'generic';
  return 'generic';
}

// Group a flat list of escalation candidates by (vendor, failure_type).
// Returns Array<{ vendor, failure_type, items: LineItem[] }>.
export function groupEscalations(candidates) {
  const buckets = new Map();
  for (const c of candidates || []) {
    const vendor = String(c.vendor || 'unknown').toLowerCase();
    const failure_type = normalizeFailureType(c.failure_type || c.escalation_reason);
    const key = vendor + '|' + failure_type;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { vendor, failure_type, items: [] };
      buckets.set(key, bucket);
    }
    bucket.items.push(c.line_item);
  }
  return Array.from(buckets.values());
}

// Compute the tick id (2h boundary, ISO of UTC slot start). The remediator
// cron fires at minute 0 of every 2nd hour, so we round 'now' down to the
// nearest even-hour UTC slot to dedup retries that fire mid-tick.
export function computeTickId(now) {
  const d = now instanceof Date ? now : new Date(now);
  const ms = d.getTime();
  const SLOT = 2 * 60 * 60 * 1000;
  const slot = new Date(Math.floor(ms / SLOT) * SLOT);
  return slot.toISOString();
}

// Build the operator notice title + body for a §H.3 batch.
export function buildEscalationIssue({ vendor, failure_type, items, tickId, parentIssueId }) {
  const title = '[auto-remediator] ' + vendor + ' / ' + failure_type
    + ' — ' + items.length + ' rental' + (items.length === 1 ? '' : 's') + ' need operator';

  const lines = [];
  lines.push('Vendor: **' + vendor + '**');
  lines.push('Failure type: `' + failure_type + '`');
  lines.push('Tick: `' + tickId + '`');
  if (parentIssueId) lines.push('Parent: ' + parentIssueId);
  lines.push('');
  lines.push('## Line items');
  lines.push('');
  for (const it of items) {
    lines.push(renderLineItem(it));
    lines.push('');
  }
  lines.push('---');
  lines.push('Auto-generated by `bad-rental-remediator`. Do NOT route via free-form Telegram/Slack.');
  return { title, body: lines.join('\n') };
}

function renderLineItem(it) {
  const parts = [];
  parts.push('### Report ' + it.report_id);
  if (it.reseller_rental_id) parts.push('- reseller_rental_id: `' + it.reseller_rental_id + '`');
  if (it.current_mdn)        parts.push('- current MDN: `' + it.current_mdn + '`');
  if (it.iccid)              parts.push('- ICCID: `' + it.iccid + '`');
  if (it.vendor)             parts.push('- vendor: `' + it.vendor + '`');
  if (it.situation_id)       parts.push('- situation: `' + it.situation_id + '`');
  if (it.attempts && it.attempts.length) {
    parts.push('- attempts:');
    for (const a of it.attempts) {
      parts.push('  - `' + (a.action || '?') + '` → `' + (a.outcome || '?') + '`'
        + (a.vendor_request_id ? '  (vendor_request_id=`' + a.vendor_request_id + '`)' : ''));
    }
  }
  if (it.latest_vendor_state) parts.push('- latest vendor state: `' + safeJson(it.latest_vendor_state) + '`');
  if (it.latest_webhook)      parts.push('- latest webhook: `' + safeJson(it.latest_webhook) + '`');
  if (it.verify_state)        parts.push('- verify: sent=`' + !!it.verify_state.sent + '` received=`' + !!it.verify_state.received + '`');
  if (it.suggested_next)      parts.push('- suggested next: ' + it.suggested_next);
  return parts.join('\n');
}

function safeJson(v) {
  try { return typeof v === 'string' ? v : JSON.stringify(v); } catch { return '<unserializable>'; }
}

// ---------------------------------------------------------
// DB-backed dedup + IncomingSMS-owned delivery.
//
// reserveEscalation: tries to insert one operator_escalations row per
// (tick_id, vendor, failure_type). On UNIQUE violation returns null —
// another tick / retry already claimed this batch. That row is the durable
// queue + audit record and is never deleted by this module.
//
// deliverEscalation: writes the batch notice into the operator inbox
// (pending_review_items) and stamps the row 'delivered' with the inbox
// reference. On failure the row goes 'delivery_failed' with last_error and
// stays drainable. Returns { ok, ref }.
//
// Schema note: `operator_escalations` predates the Paperclip removal, so the
// reference columns still carry their original names. `paperclip_issue_id`
// now holds the IncomingSMS delivery ref ('inbox:<pending_review_items.id>')
// and `paperclip_parent_id` the optional kanban parent ref. Keeping the
// column names avoids a migration on a table that already holds production
// audit rows; nothing outside this module reads them.
// ---------------------------------------------------------

// Where a delivered escalation lands. No external credential, no external
// service: both tables are IncomingSMS-owned.
export const ESCALATION_SINK = Object.freeze({
  name: 'incomingsms_operator_inbox',
  queue_table: 'operator_escalations',
  inbox_table: 'pending_review_items',
  inbox_kind: 'bad_rental_escalation',
  external_credentials_required: false,
});

// 'posted' is the legacy terminal status from the Paperclip era; rows that
// reached the old sink stay delivered and must never be re-delivered.
export const DELIVERED_STATUSES = Object.freeze(['delivered', 'posted']);
export const DELIVERY_FAILED_STATUS = 'delivery_failed';
// Legacy last_error on every row the dead Paperclip sink left behind. Kept
// only so the backlog can label those rows as drainable history — it is NOT
// a blocker any more.
export const LEGACY_CREDENTIALS_ERROR = 'paperclip_credentials_missing';

// Compatibility surface for older imports. The Paperclip sink is removed, so
// these intentionally do not require or report any Paperclip env variables.
export const PAPERCLIP_CREDENTIAL_KEYS = Object.freeze([]);
export const CREDENTIALS_MISSING_ERROR = LEGACY_CREDENTIALS_ERROR;

export function missingPaperclipCredentials(env) {
  return [];
}

export async function reserveEscalation(env, batch) {
  const row = {
    tick_id: batch.tick_id,
    vendor: batch.vendor,
    failure_type: batch.failure_type,
    report_ids: batch.report_ids || [],
    line_items: batch.line_items || [],
    paperclip_parent_id: batch.parentIssueId || null,
    status: 'queued',
  };
  const resp = await fetch(env.SUPABASE_URL + '/rest/v1/operator_escalations', {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(row),
  });
  if (resp.status === 409) return null; // UNIQUE conflict — already reserved.
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error('reserveEscalation failed ' + resp.status + ' ' + txt);
  }
  const rows = await resp.json().catch(() => []);
  return Array.isArray(rows) && rows[0] || null;
}

// One-line, identifier-free headline for the inbox list view. The full
// operator-facing detail (ICCIDs, MDNs, attempts) lives in details_md, which
// only the dashboard's escalation drawer renders.
export function buildInboxSummary(row) {
  const reports = Array.isArray(row.report_ids) ? row.report_ids.length : 0;
  const lines = Array.isArray(row.line_items) ? row.line_items.length : 0;
  const n = reports || lines;
  return 'bad-rental ' + row.vendor + '/' + row.failure_type + ': '
    + n + ' ' + (reports ? 'report' : 'SIM') + (n === 1 ? '' : 's') + ' need operator';
}

// Deliver a reserved batch into the operator inbox. The reserve above is the
// dedup gate, so this runs exactly once per (tick, vendor, failure_type)
// batch; the drainer re-runs it only for rows with no delivery ref yet.
export async function deliverEscalation(env, reservedRow, notice) {
  let inboxResp;
  try {
    inboxResp = await fetch(env.SUPABASE_URL + '/rest/v1/pending_review_items', {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify([{
        kind: ESCALATION_SINK.inbox_kind,
        summary: buildInboxSummary(reservedRow),
        details_md: notice.body,
        status: 'open',
      }]),
    });
  } catch (err) {
    await markDeliveryFailed(env, reservedRow.id, 'inbox_fetch_error: ' + String(err).slice(0, 200));
    return { ok: false, error: 'inbox_fetch_error' };
  }
  if (!inboxResp.ok) {
    const txt = await inboxResp.text().catch(() => '');
    await markDeliveryFailed(env, reservedRow.id, 'inbox_http_' + inboxResp.status + ': ' + txt.slice(0, 200));
    return { ok: false, error: 'inbox_http_' + inboxResp.status };
  }
  const created = await inboxResp.json().catch(() => []);
  const itemId = Array.isArray(created) && created[0] && created[0].id != null ? created[0].id : null;
  // Always stamp a non-null ref: it is the drainer's "already delivered"
  // guard, so an inbox row we cannot name must still close out the queue row.
  const ref = 'inbox:' + (itemId != null ? itemId : 'unknown');
  await updateEscalationRow(env, reservedRow.id, {
    status: 'delivered',
    paperclip_issue_id: ref,
    posted_at: new Date().toISOString(),
    last_error: null,
    updated_at: new Date().toISOString(),
  });
  return { ok: true, ref, inbox_item_id: itemId };
}

export async function postEscalation(env, reservedRow, notice) {
  return deliverEscalation(env, reservedRow, notice);
}

async function markDeliveryFailed(env, id, lastError) {
  return updateEscalationRow(env, id, {
    status: DELIVERY_FAILED_STATUS,
    last_error: lastError,
    updated_at: new Date().toISOString(),
  });
}

async function updateEscalationRow(env, id, patch) {
  return fetch(env.SUPABASE_URL + '/rest/v1/operator_escalations?id=eq.' + encodeURIComponent(id), {
    method: 'PATCH',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(patch),
  });
}

// ---------------------------------------------------------
// Tick-level flush. Called once at end of runTick with the candidates the
// per-report processor accumulated. Idempotent across retries within the
// same 2h slot via (tick_id, vendor, failure_type) uniqueness.
// ---------------------------------------------------------

export async function flushEscalations(env, { now = new Date(), candidates, parentIssueId } = {}) {
  if (!candidates || candidates.length === 0) {
    return { batches: 0, delivered: 0, reserved: 0, skipped_dedup: 0 };
  }
  const tickId = computeTickId(now);
  const grouped = groupEscalations(candidates);
  let delivered = 0, reserved = 0, skipped = 0;
  for (const g of grouped) {
    const row = await reserveEscalation(env, {
      tick_id: tickId,
      vendor: g.vendor,
      failure_type: g.failure_type,
      report_ids: g.items.map(it => it.report_id).filter(Boolean),
      line_items: g.items,
      parentIssueId,
    });
    if (!row) { skipped++; continue; }
    reserved++;
    const notice = buildEscalationIssue({
      vendor: g.vendor,
      failure_type: g.failure_type,
      items: g.items,
      tickId,
      parentIssueId,
    });
    const res = await deliverEscalation(env, row, notice);
    if (res.ok) delivered++;
  }
  return { batches: grouped.length, delivered, reserved, skipped_dedup: skipped, tickId };
}

// ---------------------------------------------------------
// §H.4 — vendor-batch ticket (still toggle-gated, default off).
//
// For each vendor with toggle on (KV `vendor_batch_ticket_<vendor>`='true'),
// count distinct sim_ids that have hit terminal-suspended/barred in the last
// 24h. If count ≥ 5 and we have not already opened a vendor-batch ticket
// for this (tick_id, vendor) → open one with vendor-side ICCIDs.
//
// Vendor-side ICCIDs ONLY in body; never reseller-facing identifiers.
// ---------------------------------------------------------

const VENDORS = ['atomic', 'wing_iot', 'helix', 'teltik'];
const VENDOR_BATCH_THRESHOLD = 5;
const VENDOR_BATCH_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function maybeOpenVendorBatchTickets(env, { now = new Date(), parentIssueId } = {}) {
  if (!env.REMEDIATOR_KV) return { vendors: [], opened: 0 };
  const tickId = computeTickId(now);
  const sinceIso = new Date(now.getTime() - VENDOR_BATCH_WINDOW_MS).toISOString();
  const results = [];
  let opened = 0;
  for (const vendor of VENDORS) {
    const toggle = await env.REMEDIATOR_KV.get('vendor_batch_ticket_' + vendor);
    const enabled = toggle === 'true' || toggle === '1';
    if (!enabled) {
      results.push({ vendor, enabled: false });
      continue;
    }
    const iccids = await fetchTerminalSuspendedIccids(env, vendor, sinceIso);
    if (iccids.length < VENDOR_BATCH_THRESHOLD) {
      results.push({ vendor, enabled: true, count: iccids.length, below_threshold: true });
      continue;
    }
    const reserved = await reserveEscalation(env, {
      tick_id: tickId,
      vendor,
      failure_type: 'vendor_batch',
      report_ids: [],
      line_items: iccids.map(iccid => ({ iccid })), // vendor-side only
      parentIssueId,
    });
    if (!reserved) {
      results.push({ vendor, enabled: true, count: iccids.length, skipped_dedup: true });
      continue;
    }
    const notice = buildVendorBatchIssue({ vendor, iccids, tickId, parentIssueId });
    const res = await deliverEscalation(env, reserved, notice);
    if (res.ok) opened++;
    results.push({ vendor, enabled: true, count: iccids.length, delivered: res.ok });
  }
  return { vendors: results, opened, tickId };
}

export function buildVendorBatchIssue({ vendor, iccids, tickId, parentIssueId }) {
  const title = '[vendor-batch] ' + vendor + ' — ' + iccids.length + ' SIMs terminal-suspended in 24h';
  const body = [
    'Vendor: **' + vendor + '**',
    'Window: last 24h',
    'Threshold: ≥' + VENDOR_BATCH_THRESHOLD,
    'Tick: `' + tickId + '`',
    parentIssueId ? 'Parent: ' + parentIssueId : '',
    '',
    '## Vendor-side ICCIDs',
    '',
    iccids.map(i => '- `' + i + '`').join('\n'),
    '',
    '---',
    'Vendor-side identifiers only. NO reseller-facing identifiers in this ticket.',
  ].filter(Boolean).join('\n');
  return { title, body };
}

// ---------------------------------------------------------
// Backlog visibility + out-of-band drain.
//
// Every tick reserves batches and delivers them immediately, so a healthy
// backlog is empty. Anything left is a row that failed to reach the inbox,
// plus the historical rows the dead Paperclip sink stranded — both are
// action-needed, and both are drainable with no external credential.
//
// fetchEscalationBacklog is the read side (wired into /status and into every
// tick summary). drainQueuedEscalations is the retry side — bounded,
// admin-triggered, and idempotent, so re-running it never files a second
// inbox item for a row that already delivered.
// ---------------------------------------------------------

const BACKLOG_SAMPLE_CAP = 1000;
export const DRAIN_DEFAULT_LIMIT = 25;
export const DRAIN_MAX_LIMIT = 200;

// Undelivered = anything not in DELIVERED_STATUSES. Shared by the backlog
// read and the drain candidate query so the two can never disagree.
const UNDELIVERED_FILTER = 'status=not.in.(' + DELIVERED_STATUSES.join(',') + ')';
const DRAIN_STATUS_FILTER = 'status=in.(queued,post_failed,' + DELIVERY_FAILED_STATUS + ')';

// Nothing here may include line-item content: vendor / failure_type / counts
// only. line_items carry MDNs and ICCIDs and this shape lands in KV and in
// the /status JSON.
export async function fetchEscalationBacklog(env, { detail = true } = {}) {
  const sink = { ...ESCALATION_SINK };
  const base = 'operator_escalations?' + UNDELIVERED_FILTER;
  const select = detail
    ? '&select=' + encodeURIComponent('id,status,last_error,failure_type,vendor,created_at')
      + '&order=created_at.asc&limit=' + BACKLOG_SAMPLE_CAP
    : '&select=id&limit=1';

  let resp;
  try {
    resp = await fetch(env.SUPABASE_URL + '/rest/v1/' + base + select, {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
        Prefer: 'count=exact',
        ...(detail ? {} : { Range: '0-0' }),
      },
    });
  } catch (err) {
    return { error: 'backlog_fetch_error: ' + String(err).slice(0, 200), sink };
  }
  if (!resp.ok) {
    return { error: 'backlog_http_' + resp.status, sink };
  }
  const total = parseContentRangeTotal(resp.headers && resp.headers.get('content-range'));
  if (!detail) {
    return { total, sink, alert: total > 0 };
  }
  const rows = await resp.json().catch(() => []);
  const list = Array.isArray(rows) ? rows : [];
  const tally = (field) => {
    const out = {};
    for (const r of list) {
      const k = String((r && r[field]) ?? 'null');
      out[k] = (out[k] || 0) + 1;
    }
    return out;
  };
  const deliveryFailed = list.filter(r => r && (r.status === DELIVERY_FAILED_STATUS || r.status === 'post_failed')).length;
  const legacy = list.filter(r => r && r.last_error === LEGACY_CREDENTIALS_ERROR).length;
  const oldest = list.length ? list[0].created_at : null;
  const undelivered = total != null ? total : list.length;
  return {
    total: undelivered,
    sampled: list.length,
    truncated: list.length >= BACKLOG_SAMPLE_CAP,
    by_status: tally('status'),
    by_last_error: tally('last_error'),
    by_failure_type: tally('failure_type'),
    by_vendor: tally('vendor'),
    // Rows an operator has to act on, split by why. `legacy_paperclip_rows`
    // is history awaiting a drain, not a live blocker — the sink needs no
    // credential now, so draining is the whole remedy.
    needs_action: undelivered,
    delivery_failed: deliveryFailed,
    legacy_paperclip_rows: legacy,
    oldest_created_at: oldest,
    sink,
    // The whole point of this module's rework: a non-empty undelivered
    // backlog is an alarm, not a steady state.
    alert: undelivered > 0,
    remedy: undelivered > 0 ? 'POST /escalations/drain?confirm=1 (dry-run first)' : null,
  };
}

function parseContentRangeTotal(header) {
  if (!header) return null;
  const m = String(header).match(/\/(\d+|\*)$/);
  if (!m || m[1] === '*') return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

// Rebuild the issue payload from a stored row. §H.4 vendor-batch rows carry
// bare `{iccid}` line items and need the vendor-batch body, not the §H.3 one.
export function buildIssueForRow(row) {
  const items = Array.isArray(row.line_items) ? row.line_items : [];
  if (row.failure_type === 'vendor_batch') {
    return buildVendorBatchIssue({
      vendor: row.vendor,
      iccids: items.map(it => it && it.iccid).filter(Boolean),
      tickId: row.tick_id,
      parentIssueId: row.paperclip_parent_id || null,
    });
  }
  return buildEscalationIssue({
    vendor: row.vendor,
    failure_type: row.failure_type,
    items,
    tickId: row.tick_id,
    parentIssueId: row.paperclip_parent_id || null,
  });
}

// Bounded retry over rows delivery left behind — including every row the
// removed Paperclip sink stranded. NOT wired to the cron: a backlog that
// accumulated for weeks would file hundreds of inbox items at once, so
// draining stays an explicit, bounded operator action over production rows.
//
// Duplication safety: only rows with no delivery ref (`paperclip_issue_id IS
// NULL`) and an undelivered status are candidates, and deliverEscalation
// stamps the ref + status='delivered' before we move on. A row that already
// produced an inbox item is skipped even if it is somehow re-fetched.
export async function drainQueuedEscalations(env, { limit = DRAIN_DEFAULT_LIMIT, dryRun = false } = {}) {
  const backlog = await fetchEscalationBacklog(env, { detail: true });
  const n = Math.max(1, Math.min(Number(limit) || DRAIN_DEFAULT_LIMIT, DRAIN_MAX_LIMIT));
  const q = 'operator_escalations?' + DRAIN_STATUS_FILTER + '&paperclip_issue_id=is.null'
    + '&select=*&order=created_at.asc&limit=' + n;
  const resp = await fetch(env.SUPABASE_URL + '/rest/v1/' + q, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
    },
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    return {
      ok: false,
      reason: 'backlog_fetch_failed_' + resp.status + ': ' + txt.slice(0, 200),
      delivered: 0, failed: 0, skipped: 0, planned: [], backlog,
    };
  }
  const rows = await resp.json().catch(() => []);
  const candidates = Array.isArray(rows) ? rows : [];
  let delivered = 0, failed = 0, skipped = 0;
  const planned = [];
  const errors = {};
  for (const row of candidates) {
    if (!row || DELIVERED_STATUSES.includes(row.status) || row.paperclip_issue_id) { skipped++; continue; }
    const notice = buildIssueForRow(row);
    if (dryRun) {
      // Identifier-free preview: counts, never line-item content.
      planned.push({
        id: row.id,
        tick_id: row.tick_id,
        vendor: row.vendor,
        failure_type: row.failure_type,
        status: row.status,
        last_error: row.last_error,
        report_count: (row.report_ids || []).length,
        line_item_count: (row.line_items || []).length,
        created_at: row.created_at,
      });
      continue;
    }
    const res = await deliverEscalation(env, row, notice);
    if (res.ok) delivered++;
    else { failed++; errors[res.error] = (errors[res.error] || 0) + 1; }
  }
  return {
    ok: true,
    dry_run: !!dryRun,
    limit: n,
    candidates: candidates.length,
    delivered, failed, skipped,
    errors,
    planned,
    backlog,
  };
}

async function fetchTerminalSuspendedIccids(env, vendor, sinceIso) {
  // Pull sims in terminal-suspended-shaped statuses for this vendor that
  // transitioned recently. We accept the worker DB schema's `sims.status`
  // values: 'suspended','barred','terminal_suspended','permanently_barred'.
  // `deactivated_at` and `last_status_change_at` are the recency signals; we
  // fall back to deactivated_at if the schema lacks last_status_change_at.
  const statuses = ['suspended', 'barred', 'terminal_suspended', 'permanently_barred'];
  const statusFilter = encodeURIComponent('(' + statuses.join(',') + ')');
  const q = 'sims?vendor=eq.' + encodeURIComponent(vendor)
    + '&status=in.' + statusFilter
    + '&deactivated_at=gte.' + encodeURIComponent(sinceIso)
    + '&select=iccid&limit=1000';
  const resp = await fetch(env.SUPABASE_URL + '/rest/v1/' + q, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
    },
  });
  if (!resp.ok) {
    console.log('[Escalations] vendor-batch query failed for ' + vendor + ': ' + resp.status);
    return [];
  }
  const rows = await resp.json().catch(() => []);
  const seen = new Set();
  const out = [];
  for (const r of (Array.isArray(rows) ? rows : [])) {
    if (r && r.iccid && !seen.has(r.iccid)) {
      seen.add(r.iccid);
      out.push(r.iccid);
    }
  }
  return out;
}
