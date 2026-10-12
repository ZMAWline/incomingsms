// One nightly rotation tick's counts, added to that night's rotation_runs row
// for the vendor (supabase/migrations/20261012_rotation_runs.sql). The Runs
// page lists those rows. A failed write is logged and never fails the tick.

import { sbRpc } from './supabase-rest.mjs';

export async function recordRotationTick(env, vendor, { done = 0, failed = 0, breakerTripped = false }) {
  try {
    await sbRpc(env, 'record_rotation_tick', {
      p_vendor: vendor,
      p_done: done,
      p_failed: failed,
      p_breaker_tripped: breakerTripped,
    });
  } catch (err) {
    console.error(`[RotationRuns] record_rotation_tick failed for ${vendor}: ${err}`);
  }
}
