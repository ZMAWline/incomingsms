// Exercise the shipped request gate. A link/prefetch must never activate,
// rotate or cancel a line, even when the caller is an authenticated admin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canAccess } from '../src/shared/portal-auth.mjs';
import { loadModule } from './helpers/load-worker.mjs';

const worker = (await loadModule('src/dashboard/index.js')).default;
const routes = [
  '/api/activate', '/api/cancel', '/api/suspend', '/api/restore',
  '/api/rotate-sim', '/api/fix-sim', '/api/send-test-sms',
  '/api/sim-online', '/api/debug-cancel',
];

for (const route of routes) {
  for (const method of ['GET', 'HEAD']) {
    test(`${method} ${route} performs no action for an authenticated admin`, async () => {
      const originalFetch = globalThis.fetch;
      const calls = [];
      const forbiddenFetch = async (...args) => {
        calls.push(args);
        throw new Error('Read request attempted an external action');
      };
      globalThis.fetch = forbiddenFetch;
      try {
        const binding = { fetch: forbiddenFetch };
        const response = await worker.fetch(new Request('https://dashboard.test' + route, {
          method, headers: { Authorization: 'Basic ' + btoa('test:password') },
        }), {
          DASHBOARD_BREAK_GLASS: 'on', DASHBOARD_AUTH: 'test:password',
          BULK_ACTIVATOR: binding, MDN_ROTATOR: binding,
          SIM_CANCELLER: binding, SIM_STATUS_CHANGER: binding, ASSETS: binding,
        }, { waitUntil: () => {} });
        assert.equal(response.status, 404);
        assert.equal(calls.length, 0, 'no database, carrier, service or asset calls');
      } finally { globalThis.fetch = originalFetch; }
    });
  }
  test(`viewer cannot access ${route}, regardless of method`, () => {
    for (const method of ['GET', 'HEAD', 'POST']) assert.equal(canAccess('viewer', method, route), false);
  });
}
