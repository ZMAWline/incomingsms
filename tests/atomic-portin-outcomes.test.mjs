import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyPortinRequest,
  shouldCheckPortinStatus,
  classifyPortinStatus,
  recordPortinStatusOutcome,
} from '../src/shared/atomic-portin-outcomes.mjs';

const now = '2026-09-04T12:00:00.000Z';

test('ER initiation is submitted/awaiting confirmation, not terminal failure', () => {
  const outcome = classifyPortinRequest({
    httpStatus: 200,
    response: { statusCode: '00', Result: { MSISDN: '9297134496' }, reasonCode: 'ER', reasonDescription: 'Rejected' },
    now,
  });
  assert.equal(outcome.classification, 'submitted');
  assert.equal(outcome.status, 'provisioning');
  assert.equal(outcome.reasonCode, 'ER');
  assert.equal(outcome.primaryError, null);
  assert.equal(outcome.statusCheckAttemptedAt, null);
  assert.equal(outcome.statusCheckAt, '2026-09-04T12:01:00.000Z');
});

test('submitted port-in schedules exactly one delayed status check', () => {
  const fields = classifyPortinRequest({ httpStatus: 200, response: { statusCode: '00', reasonCode: 'ER' }, now });
  assert.equal(shouldCheckPortinStatus({ ...fields, now: '2026-09-04T12:00:59.999Z' }), false);
  assert.equal(shouldCheckPortinStatus({ ...fields, now: '2026-09-04T12:01:00.000Z' }), true);
  assert.equal(shouldCheckPortinStatus({ ...fields, now: '2026-09-04T12:05:00.000Z', statusCheckAttemptedAt: '2026-09-04T12:01:00.100Z' }), false);
});

test('CO/Completed with matching MSISDN finalizes successfully', () => {
  const result = classifyPortinStatus({
    httpStatus: 200,
    response: { statusCode: '00', Result: { MSISDN: '9297134496', reasonCode: 'CO', reasonDescription: 'Completed' } },
    expectedMsisdn: '9297134496',
    initiation: { reasonCode: 'ER', reasonDescription: 'Rejected' },
  });
  assert.deepEqual(result, { classification: 'completed', status: 'active', primaryError: null });
});

test('CF/Confirmed with matching MSISDN succeeds while remaining provisioning and ending polling', () => {
  const result = classifyPortinStatus({
    httpStatus: 200,
    response: { statusCode: '00', Result: { MSISDN: '9297134496', reasonCode: 'CF', reasonDescription: 'Confirmed' } },
    expectedMsisdn: '9297134496',
    initiation: { reasonCode: 'ER', reasonDescription: 'Rejected' },
  });
  assert.deepEqual(result, {
    classification: 'completed',
    status: 'provisioning',
    reasonCode: 'CF',
    reasonDescription: 'Confirmed',
    statusCheckAt: null,
    statusCheckAttemptedAt: null,
    primaryError: null,
  });
});

test('missing request preserves the original ER initiation response as primary error', () => {
  const result = classifyPortinStatus({
    httpStatus: 200,
    response: { statusCode: '00', description: 'Port Request Does Not Exist', reasonCode: 'ER' },
    expectedMsisdn: '9297134496',
    initiation: { reasonCode: 'ER', reasonDescription: 'Rejected' },
  });
  assert.equal(result.classification, 'failed');
  assert.equal(result.status, 'error');
  assert.deepEqual(result.primaryError, { reasonCode: 'ER', reasonDescription: 'Rejected' });
});

test('a non-complete one-shot status result does not become recurring polling', () => {
  const fields = classifyPortinRequest({ httpStatus: 200, response: { statusCode: '00', reasonCode: 'ER' }, now });
  const result = classifyPortinStatus({
    httpStatus: 200,
    response: { statusCode: '00', Result: { MSISDN: '9297134496', reasonCode: 'OP', reasonDescription: 'Open' } },
    expectedMsisdn: '9297134496',
    initiation: fields,
  });
  assert.equal(result.status, 'error');
  assert.equal(shouldCheckPortinStatus({ ...fields, ...result, now: '2026-09-05T00:00:00.000Z' }), false);
});

test('recordPortinStatusOutcome writes the completed reason to the outcome columns', async () => {
  const writes = [];
  const classification = await recordPortinStatusOutcome({
    patch: async (body) => { writes.push(body); },
    iccid: '89010000000000000001',
    statusCode: '00',
    description: 'Success',
    result: { MSISDN: '9297134496', reasonCode: 'CO', reasonDescription: 'Completed' },
    msisdn: '9297134496',
    now,
  });
  assert.equal(classification, 'completed');
  assert.deepEqual(writes, [{
    atomic_portin_reason_code: 'CO',
    atomic_portin_reason_description: 'Completed',
    atomic_portin_status_attempted_at: now,
  }]);
});

test('recordPortinStatusOutcome records a carrier rejection with its description', async () => {
  const writes = [];
  const description = 'Portin status fail.Conflict statusReasonCode - 8A ~ statusReasonDescription - account number incorrect';
  const classification = await recordPortinStatusOutcome({
    patch: async (body) => { writes.push(body); },
    iccid: '89010000000000000001',
    statusCode: '951',
    description,
    result: { reasonCode: 'CT' },
    msisdn: '9297134496',
    now,
  });
  assert.equal(classification, 'failed');
  assert.deepEqual(writes, [{
    atomic_portin_reason_code: 'CT',
    atomic_portin_reason_description: description,
    atomic_portin_status_attempted_at: now,
  }]);
});

test('recordPortinStatusOutcome is non-fatal when the write fails', async () => {
  const originalError = console.error;
  const logged = [];
  console.error = (msg) => logged.push(msg);
  try {
    const classification = await recordPortinStatusOutcome({
      patch: async () => { throw new Error('Supabase PATCH 500'); },
      iccid: '89010000000000000001',
      statusCode: '00',
      result: { MSISDN: '9297134496', reasonCode: 'CO', reasonDescription: 'Completed' },
      msisdn: '9297134496',
      now,
    });
    assert.equal(classification, null);
  } finally {
    console.error = originalError;
  }
  assert.equal(logged.length, 1);
  assert.match(logged[0], /89010000000000000001: outcome write failed: Error: Supabase PATCH 500/);
});
