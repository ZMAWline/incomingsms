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
  // RPC claim_address_pool_entry returns the full row since migration
  // claim_address_pool_entry_returns_row (runtime no longer consults the
  // static pool file).
  globalThis.fetch = async () => new Response(JSON.stringify(sample), { status: 200 });
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

test('pickNextPpuAddress treats a non-record response as pool exhausted', async () => {
  const fakeEnv = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'fake' };
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify('bare-id-not-a-row'), { status: 200 });
  try {
    await assert.rejects(() => pickNextPpuAddress(fakeEnv, {}), /pool exhausted/i);
  } finally {
    globalThis.fetch = origFetch;
  }
});
