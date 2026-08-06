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
// DB-backed dedup + Paperclip POST.
//
// reserveEscalation: tries to insert one operator_escalations row per
// (tick_id, vendor, failure_type). On UNIQUE violation returns null —
// another tick / retry already claimed this batch.
//
// postEscalation: attempts Paperclip API call; updates the row to
// 'posted' on success, 'post_failed' with last_error on failure.
// Returns { ok, issueId }.
// ---------------------------------------------------------

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
  const reserved = Array.isArray(rows) && rows[0] || null;

  // Bridge into the operator's dashboard inbox (pending_review_items — the
  // same widget the rotation review uses), so bad-rental escalations and
  // rotation escalations live in ONE place. The reserve above is the dedup
  // gate, so this fires exactly once per (tick, vendor, failure_type) batch.
  // Best-effort: an inbox-write failure must never block the escalation path.
  if (reserved) {
    const ids = (batch.report_ids || []).slice(0, 20).join(', ');
    const sims = (batch.line_items || []).slice(0, 10)
      .map(li => (li && (li.sim_id != null ? `#${li.sim_id}` : li.iccid)) || '?').join(', ');
    await fetch(env.SUPABASE_URL + '/rest/v1/pending_review_items', {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify([{
        kind: 'bad_rental_escalation',
        summary: `bad-rental ${batch.vendor}/${batch.failure_type}: ${(batch.report_ids || []).length} report(s)`,
        details_md: `**Vendor:** ${batch.vendor}\n**Failure type:** ${batch.failure_type}\n**Reports:** ${ids}\n**SIMs:** ${sims}\n\n_Escalated by bad-rental-remediator (operator_escalations id ${reserved.id})._`,
        status: 'open',
      }]),
    }).catch(err => console.error('[Escalate] inbox bridge failed: ' + err));
  }
  return reserved;
}

// The two secrets postEscalation needs before it can talk to Paperclip. Kept
// as data (not an inline `if`) so the drainer and the /status surface report
// exactly the same names an operator must `wrangler secret put`.
export const PAPERCLIP_CREDENTIAL_KEYS = Object.freeze(['PAPERCLIP_API_URL', 'PAPERCLIP_API_KEY']);
export const CREDENTIALS_MISSING_ERROR = 'paperclip_credentials_missing';

export function missingPaperclipCredentials(env) {
  return PAPERCLIP_CREDENTIAL_KEYS.filter(k => !env || !env[k]);
}

export async function postEscalation(env, reservedRow, issuePayload) {
  if (missingPaperclipCredentials(env).length > 0) {
    await updateEscalationRow(env, reservedRow.id, {
      status: 'queued',
      last_error: CREDENTIALS_MISSING_ERROR,
      updated_at: new Date().toISOString(),
    });
    return { ok: false, error: CREDENTIALS_MISSING_ERROR };
  }
  const reqBody = {
    title: issuePayload.title,
    body: issuePayload.body,
    parent_id: reservedRow.paperclip_parent_id || null,
    labels: ['auto-remediator', reservedRow.vendor, reservedRow.failure_type],
  };
  let httpResp;
  try {
    httpResp = await fetch(env.PAPERCLIP_API_URL.replace(/\/+$/, '') + '/api/issues', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + env.PAPERCLIP_API_KEY,
      },
      body: JSON.stringify(reqBody),
    });
  } catch (err) {
    await updateEscalationRow(env, reservedRow.id, {
      status: 'post_failed',
      last_error: 'paperclip_fetch_error: ' + String(err).slice(0, 200),
      updated_at: new Date().toISOString(),
    });
    return { ok: false, error: 'paperclip_fetch_error' };
  }
  if (!httpResp.ok) {
    const txt = await httpResp.text().catch(() => '');
    await updateEscalationRow(env, reservedRow.id, {
      status: 'post_failed',
      last_error: 'paperclip_http_' + httpResp.status + ': ' + txt.slice(0, 200),
      updated_at: new Date().toISOString(),
    });
    return { ok: false, error: 'paperclip_http_' + httpResp.status };
  }
  const data = await httpResp.json().catch(() => ({}));
  const issueId = data && (data.id || data.issue_id || data.issueId) || null;
  await updateEscalationRow(env, reservedRow.id, {
    status: 'posted',
    paperclip_issue_id: issueId,
    posted_at: new Date().toISOString(),
    last_error: null,
    updated_at: new Date().toISOString(),
  });
  return { ok: true, issueId };
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
    return { batches: 0, posted: 0, reserved: 0, skipped_dedup: 0 };
  }
  const tickId = computeTickId(now);
  const grouped = groupEscalations(candidates);
  let posted = 0, reserved = 0, skipped = 0;
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
    const issuePayload = buildEscalationIssue({
      vendor: g.vendor,
      failure_type: g.failure_type,
      items: g.items,
      tickId,
      parentIssueId,
    });
    const post = await postEscalation(env, row, issuePayload);
    if (post.ok) posted++;
  }
  return { batches: grouped.length, posted, reserved, skipped_dedup: skipped, tickId };
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
    const issuePayload = buildVendorBatchIssue({ vendor, iccids, tickId, parentIssueId });
    const post = await postEscalation(env, reserved, issuePayload);
    if (post.ok) opened++;
    results.push({ vendor, enabled: true, count: iccids.length, posted: post.ok });
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
// postEscalation deliberately leaves a row `queued` when the Paperclip
// secrets are absent, so nothing is lost. The failure mode that bit us is
// that nothing ever LOOKED at those rows again: every tick reserved more
// batches and the queue grew unbounded and unreported.
//
// fetchEscalationBacklog is the read side (wired into /status and into every
// tick summary). drainQueuedEscalations is the retry side — bounded,
// admin-triggered, and idempotent, so it can be run once the secrets exist
// without minting a duplicate issue for a row that already posted.
// ---------------------------------------------------------

const BACKLOG_SAMPLE_CAP = 1000;
export const DRAIN_DEFAULT_LIMIT = 25;
export const DRAIN_MAX_LIMIT = 200;

// Nothing here may include line-item content: vendor / failure_type / counts
// only. line_items carry MDNs and ICCIDs and this shape lands in KV and in
// the /status JSON.
export async function fetchEscalationBacklog(env, { detail = true } = {}) {
  const missing = missingPaperclipCredentials(env);
  const sink = { paperclip_configured: missing.length === 0, missing_env: missing };
  const base = 'operator_escalations?status=neq.posted';
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
    return { total, sink, alert: total > 0 && !sink.paperclip_configured };
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
  const blocked = list.filter(r => r && r.last_error === CREDENTIALS_MISSING_ERROR).length;
  const oldest = list.length ? list[0].created_at : null;
  return {
    total: total != null ? total : list.length,
    sampled: list.length,
    truncated: list.length >= BACKLOG_SAMPLE_CAP,
    by_status: tally('status'),
    by_last_error: tally('last_error'),
    by_failure_type: tally('failure_type'),
    by_vendor: tally('vendor'),
    blocked_on_credentials: blocked,
    oldest_created_at: oldest,
    sink,
    // The whole point of this module's rework: a non-empty credential-blocked
    // backlog is an alarm, not a steady state.
    alert: blocked > 0 || (!sink.paperclip_configured && (total || list.length) > 0),
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

// Bounded retry over rows postEscalation left behind. NOT wired to the cron:
// a backlog that accumulated for weeks would post hundreds of issues the
// instant the secrets landed, so draining stays an explicit operator action.
//
// Duplication safety: only rows with `paperclip_issue_id IS NULL` and a
// non-posted status are candidates, and postEscalation stamps the id +
// status='posted' before we move on. A row that already produced an issue is
// skipped even if it is somehow re-fetched.
export async function drainQueuedEscalations(env, { limit = DRAIN_DEFAULT_LIMIT, dryRun = false } = {}) {
  const missing = missingPaperclipCredentials(env);
  const backlog = await fetchEscalationBacklog(env, { detail: true });
  if (missing.length > 0) {
    // Deliberately do NOT touch the rows: rewriting last_error on every
    // attempt would churn updated_at and hide how long the backlog has sat.
    return {
      ok: false,
      reason: CREDENTIALS_MISSING_ERROR,
      missing_env: missing,
      posted: 0, failed: 0, skipped: 0, planned: [],
      backlog,
    };
  }
  const n = Math.max(1, Math.min(Number(limit) || DRAIN_DEFAULT_LIMIT, DRAIN_MAX_LIMIT));
  const q = 'operator_escalations?status=in.(queued,post_failed)&paperclip_issue_id=is.null'
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
      posted: 0, failed: 0, skipped: 0, planned: [], backlog,
    };
  }
  const rows = await resp.json().catch(() => []);
  const candidates = Array.isArray(rows) ? rows : [];
  let posted = 0, failed = 0, skipped = 0;
  const planned = [];
  const errors = {};
  for (const row of candidates) {
    if (!row || row.status === 'posted' || row.paperclip_issue_id) { skipped++; continue; }
    const issuePayload = buildIssueForRow(row);
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
    const res = await postEscalation(env, row, issuePayload);
    if (res.ok) posted++;
    else { failed++; errors[res.error] = (errors[res.error] || 0) + 1; }
  }
  return {
    ok: true,
    dry_run: !!dryRun,
    limit: n,
    candidates: candidates.length,
    posted, failed, skipped,
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
