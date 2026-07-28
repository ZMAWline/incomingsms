// =========================================================
// Cooldown engine (INC-18 / INC-16b) — pure logic.
//
// Source of truth: Plan v4 §G cooldown table.
//
//   action               | max_attempts | cooldown   | idempotency key shape
//   ---------------------+--------------+------------+------------------------
//   db_sync_upsert       | 1            | n/a        | (sim_id)
//   resend_online        | 2            | 1h         | (report_id, sim_id, attempt_no)
//   atomic_ota           | 1            | 24h        | vendor request_id
//   atomic_restore       | 1            | 24h        | (MSISDN)
//   wing_put_dialable    | 1            | 24h        | (ICCID)
//   helix_ota            | 1            | 24h        | vendor request_id
//   helix_unsuspend      | 1            | 24h        | vendor request_id
//   teltik_reset_network | 1            | 24h        | (MDN10)
//   teltik_reset_port    | 1            | 24h        | (MDN10)
//   verify_send_sms      | 3            | 60s        | (report_id, attempt_no, nonce)
//   classify_only        | 3 ticks      | 2h         | (report_id, mode)
//
// Public surface:
//   COOLDOWN_TABLE — frozen record of the above.
//   canAttempt({ action, priorAttempts, lastAttemptAt, now }) → boolean | reason.
//   nextReviewAt({ action, now }) → ISO string | null.
//   idempotencyKey(action, ctx) → string — for de-dup at the write boundary.
//
// All timestamps are passed in as Date objects or millisecond epochs.
// The engine is deterministic — never reads Date.now() itself.
// =========================================================

const H = 60 * 60 * 1000;
const M = 60 * 1000;
const S = 1000;

export const COOLDOWN_TABLE = Object.freeze({
  db_sync_upsert:       { maxAttempts: 1, cooldownMs: 0,       label: 'n/a' },
  resend_online:        { maxAttempts: 2, cooldownMs: 1 * H,   label: '1h' },
  atomic_ota:           { maxAttempts: 1, cooldownMs: 24 * H,  label: '24h' },
  atomic_restore:       { maxAttempts: 1, cooldownMs: 24 * H,  label: '24h' },
  wing_put_dialable:    { maxAttempts: 1, cooldownMs: 24 * H,  label: '24h' },
  helix_ota:            { maxAttempts: 1, cooldownMs: 24 * H,  label: '24h' },
  helix_unsuspend:      { maxAttempts: 1, cooldownMs: 24 * H,  label: '24h' },
  teltik_reset_network: { maxAttempts: 1, cooldownMs: 24 * H,  label: '24h' },
  teltik_reset_port:    { maxAttempts: 1, cooldownMs: 24 * H,  label: '24h' },
  teltik_sync_iccid:    { maxAttempts: 2, cooldownMs: 0,       label: 'n/a' },
  verify_send_sms:      { maxAttempts: 3, cooldownMs: 60 * S,  label: '60s' },
  classify_only:        { maxAttempts: 3, cooldownMs: 2 * H,   label: '2h' },
  close_duplicate:      { maxAttempts: 1, cooldownMs: 0,       label: 'n/a' },
  escalate:             { maxAttempts: 1, cooldownMs: 0,       label: 'n/a' },
});

export function canAttempt({ action, priorAttempts, lastAttemptAt, now }) {
  const row = COOLDOWN_TABLE[action];
  if (!row) return { ok: false, reason: 'unknown_action' };

  const attempts = Number.isFinite(priorAttempts) ? priorAttempts : 0;
  if (attempts >= row.maxAttempts) {
    return { ok: false, reason: 'max_attempts_reached', attempts, max: row.maxAttempts };
  }

  if (row.cooldownMs > 0 && lastAttemptAt && now) {
    const last = toMs(lastAttemptAt);
    const cur  = toMs(now);
    if (Number.isFinite(last) && cur - last < row.cooldownMs) {
      return {
        ok: false, reason: 'cooldown_active',
        nextEligibleAt: new Date(last + row.cooldownMs).toISOString(),
      };
    }
  }
  return { ok: true };
}

export function nextReviewAt({ action, now }) {
  const row = COOLDOWN_TABLE[action];
  if (!row) return null;
  if (!row.cooldownMs) return null;
  const cur = toMs(now);
  if (!Number.isFinite(cur)) return null;
  return new Date(cur + row.cooldownMs).toISOString();
}

// Builds a deterministic idempotency key per §G column 3.
export function idempotencyKey(action, ctx = {}) {
  switch (action) {
    case 'db_sync_upsert':
      return 'db_sync_upsert:' + req(ctx, 'sim_id');
    case 'resend_online':
      return 'resend_online:' + req(ctx, 'report_id')
           + ':' + req(ctx, 'sim_id')
           + ':' + req(ctx, 'attempt_no');
    case 'atomic_ota':
    case 'helix_ota':
    case 'helix_unsuspend':
      // Vendor request_id is generated at the call boundary; for the worker
      // dedup-window we hash report_id+attempt so duplicate ticks don't double-call.
      return action + ':' + req(ctx, 'report_id') + ':' + req(ctx, 'attempt_no');
    case 'atomic_restore':
      return 'atomic_restore:' + req(ctx, 'msisdn');
    case 'wing_put_dialable':
      return 'wing_put_dialable:' + req(ctx, 'iccid');
    case 'teltik_reset_network':
      return 'teltik_reset_network:' + req(ctx, 'mdn10');
    case 'teltik_reset_port':
      return 'teltik_reset_port:' + req(ctx, 'mdn10');
    case 'verify_send_sms':
      return 'verify_send_sms:' + req(ctx, 'report_id')
           + ':' + req(ctx, 'attempt_no')
           + ':' + req(ctx, 'nonce');
    case 'classify_only':
      return 'classify_only:' + req(ctx, 'report_id') + ':' + req(ctx, 'mode');
    case 'close_duplicate':
      return 'close_duplicate:' + req(ctx, 'report_id');
    case 'escalate':
      return 'escalate:' + req(ctx, 'report_id') + ':' + (ctx.reason || 'generic');
    default:
      throw new Error('unknown_action_for_idempotency:' + action);
  }
}

function req(ctx, k) {
  const v = ctx[k];
  if (v === null || v === undefined || v === '') {
    throw new Error('missing_idempotency_field:' + k);
  }
  return v;
}

function toMs(t) {
  if (t === null || t === undefined) return NaN;
  if (t instanceof Date) return t.getTime();
  if (typeof t === 'number') return t;
  if (typeof t === 'string') {
    const d = Date.parse(t);
    return Number.isFinite(d) ? d : NaN;
  }
  return NaN;
}
