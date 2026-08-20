// =========================================================
// Slack notifications for Teltik gateway-port offline events (TH5).
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
