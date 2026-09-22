// src/shared/fetch-timeout.mjs bounds every outbound carrier, Supabase and
// webhook call so a hung request becomes a normal thrown Error instead of
// holding the Worker invocation until the platform kills it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  fetchWithTimeout,
  supabaseFetch,
  carrierFetch,
  webhookFetch,
  timeoutFor,
  CARRIER_TIMEOUT_MS,
  SUPABASE_TIMEOUT_MS,
  WEBHOOK_TIMEOUT_MS,
} from '../src/shared/fetch-timeout.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// A fetch that only ever settles through its abort signal: a hung socket.
function hangingFetch(calls = []) {
  return (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason));
    });
  };
}

async function withFetch(fake, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = fake;
  try { return await fn(); } finally { globalThis.fetch = orig; }
}

test('defaults per call class', () => {
  assert.equal(CARRIER_TIMEOUT_MS, 45_000);
  assert.equal(SUPABASE_TIMEOUT_MS, 15_000);
  assert.equal(WEBHOOK_TIMEOUT_MS, 10_000);
  assert.equal(timeoutFor({}, 'CARRIER'), 45_000);
  assert.equal(timeoutFor(undefined, 'SUPABASE'), 15_000);
  assert.equal(timeoutFor({}, 'WEBHOOK'), 10_000);
});

test('env FETCH_TIMEOUT_<KIND>_MS overrides the default; junk values are ignored', () => {
  assert.equal(timeoutFor({ FETCH_TIMEOUT_CARRIER_MS: '60000' }, 'CARRIER'), 60_000);
  assert.equal(timeoutFor({ FETCH_TIMEOUT_SUPABASE_MS: '5000' }, 'SUPABASE'), 5_000);
  assert.equal(timeoutFor({ FETCH_TIMEOUT_WEBHOOK_MS: '2500' }, 'WEBHOOK'), 2_500);
  assert.equal(timeoutFor({ FETCH_TIMEOUT_SUPABASE_MS: 'abc' }, 'SUPABASE'), 15_000);
  assert.equal(timeoutFor({ FETCH_TIMEOUT_SUPABASE_MS: '0' }, 'SUPABASE'), 15_000);
});

test('fetchWithTimeout rejects a hung request with the label and timeout in the message', async () => {
  await withFetch(hangingFetch(), async () => {
    await assert.rejects(
      () => fetchWithTimeout('https://example.com/x', {}, { timeoutMs: 20, label: 'ATOMIC portinStatus' }),
      (err) => err instanceof Error && err.message === 'ATOMIC portinStatus timeout after 20ms',
    );
  });
});

test('fetchWithTimeout passes the response and init through on success', async () => {
  const calls = [];
  const fake = async (url, init) => { calls.push({ url, init }); return new Response('ok', { status: 201 }); };
  await withFetch(fake, async () => {
    const res = await fetchWithTimeout('https://example.com/y', { method: 'POST', body: 'b', headers: { a: '1' } }, { timeoutMs: 1000, label: 'x' });
    assert.equal(res.status, 201);
    assert.equal(await res.text(), 'ok');
  });
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.body, 'b');
  assert.deepEqual(calls[0].init.headers, { a: '1' });
  assert.ok(calls[0].init.signal, 'a signal is attached');
});

test('non-timeout errors pass through unchanged', async () => {
  const boom = new TypeError('fetch failed');
  await withFetch(async () => { throw boom; }, async () => {
    await assert.rejects(() => fetchWithTimeout('https://example.com', {}, { timeoutMs: 1000 }), (e) => e === boom);
  });
});

test('supabaseFetch uses the env override and labels with method + path, never the query', async () => {
  await withFetch(hangingFetch(), async () => {
    await assert.rejects(
      () => supabaseFetch({ FETCH_TIMEOUT_SUPABASE_MS: '15' }, 'https://abc.supabase.co/rest/v1/sims?id=eq.5', { method: 'PATCH' }),
      (err) => err.message === 'Supabase PATCH abc.supabase.co/rest/v1/sims timeout after 15ms',
    );
  });
});

test('carrierFetch through the relay names the real carrier host and drops the apikey query', async () => {
  await withFetch(hangingFetch(), async () => {
    await assert.rejects(
      () => carrierFetch({ FETCH_TIMEOUT_CARRIER_MS: '15' }, 'https://relay.example.com/https://api.smsgateway.xyz/v1/port-status?apikey=SECRET&mdn=1', {}),
      (err) => err.message === 'carrier GET api.smsgateway.xyz/v1/port-status timeout after 15ms' && !err.message.includes('SECRET'),
    );
  });
});

test('webhookFetch labels by host only: a Slack webhook path is itself the secret', async () => {
  await withFetch(hangingFetch(), async () => {
    await assert.rejects(
      () => webhookFetch({ FETCH_TIMEOUT_WEBHOOK_MS: '15' }, 'https://hooks.slack.com/services/T0/B0/SECRETTOKEN', { method: 'POST' }),
      (err) => err.message === 'webhook POST hooks.slack.com timeout after 15ms',
    );
  });
});

// --- source scan -------------------------------------------------------------
// Every outbound fetch() in worker code must go through the helper. Browser
// code inside portal HTML templates (fetch('/api/...')) is same-origin and
// exempt. Anything else needs `// timeout-exempt: <why>` on the line or the
// line above.

function workerSourceFiles() {
  const out = [];
  for (const dir of fs.readdirSync(path.join(ROOT, 'src'))) {
    if (dir === 'dashboard') continue;
    const abs = path.join(ROOT, 'src', dir);
    if (!fs.statSync(abs).isDirectory()) continue;
    for (const f of fs.readdirSync(abs)) {
      if (!/\.(js|mjs)$/.test(f) || f.startsWith('_')) continue;
      if (dir === 'shared' && f === 'fetch-timeout.mjs') continue;
      out.push(path.join('src', dir, f));
    }
  }
  return out;
}

export function findBareFetches(src) {
  const hits = [];
  const lines = src.split('\n');
  const re = /(^|[^.\w$])fetch\(\s*/g;
  let m;
  while ((m = re.exec(src))) {
    const start = m.index + m[1].length;
    const before = src.slice(Math.max(0, start - 20), start);
    if (/async\s+$/.test(before)) continue; // the Worker's own fetch(request) handler
    const lineNo = src.slice(0, start).split('\n').length;
    const line = lines[lineNo - 1];
    if (/^\s*(\/\/|\*)/.test(line)) continue; // comment
    const arg = src.slice(m.index + m[0].length, m.index + m[0].length + 2);
    if (/^['"`]\//.test(arg)) continue; // same-origin browser call in portal HTML
    const exempt = /timeout-exempt:\s*\S/.test(line) || /timeout-exempt:\s*\S/.test(lines[lineNo - 2] || '');
    if (!exempt) hits.push(lineNo + ': ' + line.trim());
  }
  return hits;
}

test('scanner flags bare fetches and honours the exemptions', () => {
  const src = [
    "const a = await fetch(`${env.SUPABASE_URL}/rest/v1/sims`);",
    "const b = await fetch(",
    "  env.RELAY_URL + '/' + url);",
    "  async fetch(request, env) {",
    "const c = await env.SKYLINE_GATEWAY.fetch(url);",
    "fetch('/api/lines', { credentials: 'include' })",
    "// fetch(url) in a comment",
    "const d = await fetch(url); // timeout-exempt: test fixture",
    "// timeout-exempt: long poll with its own bound",
    "const e = await fetch(url);",
    "const f = await supabaseFetch(env, url);",
  ].join('\n');
  assert.deepEqual(findBareFetches(src), [
    "1: const a = await fetch(`${env.SUPABASE_URL}/rest/v1/sims`);",
    '2: const b = await fetch(',
  ]);
});

test('no worker outside the dashboard makes a bare fetch() to Supabase, a carrier, or a webhook', () => {
  const offenders = [];
  for (const f of workerSourceFiles()) {
    for (const hit of findBareFetches(fs.readFileSync(path.join(ROOT, f), 'utf8'))) {
      offenders.push(f + ':' + hit);
    }
  }
  assert.deepEqual(offenders, [], 'wrap these in supabaseFetch / carrierFetch / webhookFetch (src/shared/fetch-timeout.mjs) or mark `// timeout-exempt: <why>`');
});
