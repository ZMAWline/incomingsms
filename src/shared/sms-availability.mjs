// =========================================================
// TEMPORARY repo-wide outbound-SMS kill switch (2026-07-29).
//
// All Skyline gateways are powered off, so every outbound SMS send fails at
// the hardware. Until they're back, every outbound send path checks
// smsSendingEnabled() and returns SMS_UNAVAILABLE_MESSAGE instead of calling
// the gateway. Inbound SMS is unaffected.
//
// Re-enable: flip SMS_TEMPORARILY_DISABLED to false and redeploy the workers
// that import this (skyline-gateway, bad-rental-remediator). Per-worker
// override without a code change: set the worker var SMS_SENDING_ENABLED='true'.
// =========================================================

export const SMS_TEMPORARILY_DISABLED = true;

export const SMS_UNAVAILABLE_MESSAGE = 'SMS not available right now';

export function smsSendingEnabled(env) {
  if (env && env.SMS_SENDING_ENABLED === 'true') return true;
  return !SMS_TEMPORARILY_DISABLED;
}
