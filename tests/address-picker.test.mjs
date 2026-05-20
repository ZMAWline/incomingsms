import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APEX_VENDORS, isApexVendor, pickNextPpuAddress } from '../src/shared/address-picker.mjs';
import { ADDRESS_POOL } from '../src/shared/address-pool.mjs';

test('APEX_VENDORS contains atomic and helix', () => {
  assert.deepEqual([...APEX_VENDORS].sort(), ['atomic', 'helix']);
});

test('isApexVendor returns true only for apex vendors', () => {
  assert.equal(isApexVendor('atomic'), true);
  assert.equal(isApexVendor('helix'),  true);
  assert.equal(isApexVendor('teltik'), false);
  assert.equal(isApexVendor('wing_iot'), false);
  assert.equal(isApexVendor(undefined), false);
});

test('pickNextPpuAddress returns full address record on RPC hit', async () => {
  const sample = ADDRESS_POOL[0];
  const fakeEnv = {
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'fake',
  };
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(sample.id), { status: 200 });
  try {
    const got = await pickNextPpuAddress(fakeEnv, {});
    assert.equal(got.id, sample.id);
    assert.equal(got.zipCode, sample.zipCode);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('pickNextPpuAddress throws on pool exhausted (RPC returns null)', async () => {
  const fakeEnv = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'fake' };
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('null', { status: 200 });
  try {
    await assert.rejects(
      () => pickNextPpuAddress(fakeEnv, { excludeState: 'CA', excludeZip: '90012' }),
      /pool exhausted/i
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('pickNextPpuAddress throws on RPC error', async () => {
  const fakeEnv = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'fake' };
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('boom', { status: 500 });
  try {
    await assert.rejects(() => pickNextPpuAddress(fakeEnv, {}), /HTTP 500/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('pickNextPpuAddress throws if DB returns id not in static pool', async () => {
  const fakeEnv = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'fake' };
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify('does-not-exist-id'), { status: 200 });
  try {
    await assert.rejects(() => pickNextPpuAddress(fakeEnv, {}), /not in static pool/);
  } finally {
    globalThis.fetch = origFetch;
  }
});
