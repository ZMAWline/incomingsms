// =========================================================
// Slack notifications for Teltik gateway-port offline events.
//
// Two independent paths:
//   notifyPortOffline        — report-driven (TH5 classification), one
//                               message per line, only fires when a
//                               bad-rental report already exists for it.
//   notifyOfflineFleetSummary — fleet-driven, one batch digest per run,
//                               covers every currently-offline Teltik line
//                               regardless of whether any report exists.
// See notifyOfflineFleetSummary's own doc comment below for why the first
// one alone isn't enough.
//
// Fire-and-forget from the caller's perspective in effect, but implemented
// as an awaited call that swallows its own errors — a Slack outage or a
// missing webhook must never fail report processing (see processReport in
// index.js, which awaits notifyPortOffline but never lets it throw).
//
// Dedup uses REMEDIATOR_KV (same namespace as the kill-switch/tick-lock,
// keyspace prefixed bad_rental_remediator_notify_port_offline:) rather than
// the report-attempt cooldown system in cooldown.mjs: an alert is keyed by
// ICCID + event kind, not by report_id/action, and recording it as a
// remediation attempt would pollute the rental_report_remediation_attempts
// audit trail (which is for actual vendor actions) with a notification.
//
// relayFetch is a local copy (not imported from vendor.mjs, which doesn't
// export it) — this repo's convention is per-worker/per-module copies of
// this helper rather than a shared import.
// =========================================================

const FIRST_DETECTION_TTL_S = 60 * 60; // 1h — re-alert if a line is still offline an hour later
const STILL_OFFLINE_TTL_S = 24 * 60 * 60; // 24h — mirrors the teltik_reset_port cooldown gating this branch
const SLACK_POST_TIMEOUT_MS = 8000;

function relayFetch(env, url, init) {
  if (env.RELAY_URL && env.RELAY_KEY) {
    return fetch(env.RELAY_URL + '/' + url, {
      ...init,
      headers: { ...(init && init.headers || {}), 'x-relay-key': env.RELAY_KEY },
    });
  }
  return fetch(url, init);
}

async function postToSlack(env, webhookUrl, payload) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('slack post timeout after ' + SLACK_POST_TIMEOUT_MS + 'ms')), SLACK_POST_TIMEOUT_MS);
  try {
    const res = await relayFetch(env, webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.log('[Remediator] Slack post failed HTTP ' + res.status);
      return { ok: false, status: res.status };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    console.log('[Remediator] Slack post exception: ' + (err && err.message || err));
    return { ok: false, status: 0, error: String(err && err.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

// Returns true the first time `key` is seen within ttlSeconds, false on a
// repeat. Fails open (returns true) on any KV error or when REMEDIATOR_KV
// isn't bound — a missed dedup is far cheaper than a missed alert.
async function dedupOnce(env, key, ttlSeconds) {
  if (!env.REMEDIATOR_KV) return true;
  try {
    const existing = await env.REMEDIATOR_KV.get(key);
    if (existing) return false;
    await env.REMEDIATOR_KV.put(key, new Date().toISOString(), { expirationTtl: ttlSeconds });
    return true;
  } catch (err) {
    console.log('[Remediator] notify dedup error: ' + err);
    return true;
  }
}

function buildPortOfflineMessage({ kind, sim, portStatus, priorResets }) {
  const iccid = (sim && sim.iccid) || 'unknown';
  const mdn = (sim && sim.current_mdn_e164) || 'unknown';
  const gatewayHost = (sim && sim.gateway_host) || 'teltik';
  const stillOffline = kind === 'still_offline_after_reset';
  const header = stillOffline
    ? ':rotating_light: Teltik port still offline after auto-reset'
    : ':warning: Teltik port offline';
  const lines = [
    '*ICCID:* `' + iccid + '`',
    '*MDN:* `' + mdn + '`',
    '*Gateway host:* ' + gatewayHost,
    '*Port status:* ' + (portStatus || 'offline'),
  ];
  if (stillOffline) {
    lines.push('*Prior reset attempts:* ' + (priorResets || 0));
    lines.push('_Auto-reset already attempted and the port is still offline — needs manual attention._');
  } else {
    lines.push('_Auto-reset queued for this line._');
  }
  return {
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: header, emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'Generated: ' + new Date().toISOString() }] },
    ],
  };
}

// Called from processReport right after classification, for the two TH5
// offline reasons only. kind: 'first_detection' | 'still_offline_after_reset'.
// Never throws — a notification failure must never affect report processing.
export async function notifyPortOffline(env, { kind, sim, portStatus, priorResets = 0 } = {}) {
  try {
    if (!env.SLACK_WEBHOOK_URL) return { ok: false, skipped: 'no_webhook' };
    const iccid = (sim && sim.iccid) || (sim && sim.id) || 'unknown';
    const ttl = kind === 'still_offline_after_reset' ? STILL_OFFLINE_TTL_S : FIRST_DETECTION_TTL_S;
    const key = 'bad_rental_remediator_notify_port_offline:' + kind + ':' + iccid;
    const allowed = await dedupOnce(env, key, ttl);
    if (!allowed) return { ok: true, skipped: 'deduped' };
    const payload = buildPortOfflineMessage({ kind, sim, portStatus, priorResets });
    return await postToSlack(env, env.SLACK_WEBHOOK_URL, payload);
  } catch (err) {
    console.log('[Remediator] notifyPortOffline error: ' + (err && err.message || err));
    return { ok: false, error: String(err && err.message || err) };
  }
}

// =========================================================
// Fleet-wide offline digest — independent of bad-rental report processing.
//
// notifyPortOffline (above) only ever fires for a line that already has an
// open bad-rental report attached to it (a reseller/customer complaint).
// That misses the common case: a line goes offline with no report ever
// filed on it, which is most of the fleet once coverage improved (rotating
// cron + the teltik-portal). This queries the ACTUAL current status of
// every Teltik-hosted line (get_teltik_currently_offline — latest recorded
// check per line, filtered to state='offline') and sends a single batch
// summary, not one message per line, so a mass-outage or a cold start
// against an already-large offline count can't spam the channel.
//
// Sends twice a day — 8:00 AM and 4:00 PM America/New_York — instead of on
// every 15-minute cron tick. The worker's own cron trigger stays at */15
// (no new Cloudflare cron needed); this function just no-ops outside those
// two windows. Time is computed via Intl (DST-aware), the same pattern
// src/teltik-worker/index.js#getNYHour already uses, rather than a fixed
// UTC cron that would silently drift an hour off after a DST change.
// =========================================================

const DIGEST_WINDOWS = [
  { key: 'morning', hour: 8 },
  { key: 'afternoon', hour: 16 },
];
const DIGEST_WINDOW_MINUTES = 15; // matches the */15 cron tick spacing
const DIGEST_DEDUP_TTL_S = 18 * 60 * 60; // clears well before the same window recurs next day
const FLEET_OFFLINE_LIST_CAP = 15;
const SB_FETCH_TIMEOUT_MS = 15000;

// Hour/minute/date in America/New_York, DST-aware via Intl. hour12:false can
// report midnight as "24" in some ICU builds, so normalize with %24 the same
// way getNYHour() in teltik-worker/index.js does.
function nyNow(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false,
  }).formatToParts(now);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const hour = ((get('hour') % 24) + 24) % 24;
  const minute = get('minute');
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now); // YYYY-MM-DD
  return { hour, minute, date };
}

// Returns { key, date } when `now` falls inside the first DIGEST_WINDOW_MINUTES
// of a configured hour, else null. `now` is injectable for tests.
function currentDigestWindow(now = new Date()) {
  const { hour, minute, date } = nyNow(now);
  const win = DIGEST_WINDOWS.find((w) => w.hour === hour && minute < DIGEST_WINDOW_MINUTES);
  return win ? { key: win.key, date } : null;
}

function sbHeaders(env) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
    'Content-Type': 'application/json',
  };
}

async function fetchCurrentlyOfflineLines(env) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('fetch timeout after ' + SB_FETCH_TIMEOUT_MS + 'ms')), SB_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(env.SUPABASE_URL + '/rest/v1/rpc/get_teltik_currently_offline', {
      method: 'POST',
      headers: sbHeaders(env),
      body: JSON.stringify({}),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error('get_teltik_currently_offline HTTP ' + res.status);
    const rows = await res.json();
    return Array.isArray(rows) ? rows : [];
  } finally {
    clearTimeout(timer);
  }
}

// Overridable via TELTIK_PORTAL_URL so the link can follow a future custom
// domain without a code change; falls back to the current production URL.
const TELTIK_PORTAL_URL_DEFAULT = 'https://teltik-portal.zalmen-531.workers.dev';

function buildFleetOfflineMessage(env, offline) {
  const shown = offline.slice(0, FLEET_OFFLINE_LIST_CAP);
  const lines = shown.map((l) => '• `' + (l.iccid || 'unknown') + '`' + (l.mdn ? ' — ' + l.mdn : ''));
  if (offline.length > shown.length) lines.push('_...and ' + (offline.length - shown.length) + ' more_');
  const portalUrl = (env && env.TELTIK_PORTAL_URL) || TELTIK_PORTAL_URL_DEFAULT;
  return {
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: ':rotating_light: ' + offline.length + ' Teltik line(s) currently offline', emoji: true },
      },
      { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
      {
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: '<' + portalUrl + '/offline|View all offline lines> — generated ' + new Date().toISOString(),
        }],
      },
    ],
  };
}

// Runs on bad-rental-remediator's existing 15-min cron (see index.js
// scheduled()), independent of report processing. Most ticks exit
// immediately on the window check below, before any Supabase call. Dedup
// is keyed per calendar day + window, so it sends once at 8 AM and once at
// 4 PM, not on every tick that happens to land inside those 15-minute
// bracket — and an empty-offline-list run never consumes the dedup slot,
// so a line going offline later in the same window still gets reported.
export async function notifyOfflineFleetSummary(env, { now } = {}) {
  try {
    if (!env.SLACK_WEBHOOK_URL) return { ok: false, skipped: 'no_webhook' };
    const window = currentDigestWindow(now);
    if (!window) return { ok: true, skipped: 'outside_digest_window' };

    const offline = await fetchCurrentlyOfflineLines(env);
    if (!offline.length) return { ok: true, skipped: 'none_offline' };

    const dedupKey = 'bad_rental_remediator_notify_fleet_offline_summary:' + window.date + ':' + window.key;
    const allowed = await dedupOnce(env, dedupKey, DIGEST_DEDUP_TTL_S);
    if (!allowed) return { ok: true, skipped: 'deduped', offline_count: offline.length };

    const payload = buildFleetOfflineMessage(env, offline);
    const result = await postToSlack(env, env.SLACK_WEBHOOK_URL, payload);
    return { ...result, offline_count: offline.length };
  } catch (err) {
    console.log('[Remediator] notifyOfflineFleetSummary error: ' + (err && err.message || err));
    return { ok: false, error: String(err && err.message || err) };
  }
}
