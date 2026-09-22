// breakGlassUser: the legacy shared Basic password is off unless
// DASHBOARD_BREAK_GLASS is exactly 'on' (any case). Runs the real code from
// src/dashboard/auth-routes.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { breakGlassUser } from '../src/dashboard/auth-routes.mjs';

const PASSWORD = 'admin:correct-horse';

function req(password) {
  const headers = password == null ? {} : { Authorization: 'Basic ' + btoa(password) };
  return new Request('https://dash.test/api/sims', { headers });
}

function env(flag) {
  const e = { DASHBOARD_AUTH: PASSWORD };
  if (flag !== undefined) e.DASHBOARD_BREAK_GLASS = flag;
  return e;
}

test('flag unset: break-glass is rejected even with the right password', () => {
  assert.equal(breakGlassUser(env(undefined), req(PASSWORD)), null);
  assert.equal(breakGlassUser(env(''), req(PASSWORD)), null);
});

test('flag "off": break-glass is rejected', () => {
  assert.equal(breakGlassUser(env('off'), req(PASSWORD)), null);
});

test('any value other than "on" is off', () => {
  for (const v of ['true', '1', 'yes', 'enabled', ' on', 'on ', 'onn']) {
    assert.equal(breakGlassUser(env(v), req(PASSWORD)), null, v);
  }
});

test('flag "on": correct password is accepted as admin', () => {
  const u = breakGlassUser(env('on'), req(PASSWORD));
  assert.deepEqual(u, { id: null, username: 'break-glass', role: 'admin', sessionId: null });
});

test('flag is case-insensitive', () => {
  assert.ok(breakGlassUser(env('ON'), req(PASSWORD)));
  assert.ok(breakGlassUser(env('On'), req(PASSWORD)));
});

test('flag "on": wrong, near-miss, and missing passwords are rejected', () => {
  for (const pw of ['wrong', PASSWORD + 'x', PASSWORD.slice(0, -1), PASSWORD.slice(0, -1) + 'X', PASSWORD.toUpperCase(), '']) {
    assert.equal(breakGlassUser(env('on'), req(pw)), null, JSON.stringify(pw));
  }
  assert.equal(breakGlassUser(env('on'), req(null)), null);
});

test('flag "on" but DASHBOARD_AUTH unset: rejected', () => {
  assert.equal(breakGlassUser({ DASHBOARD_BREAK_GLASS: 'on' }, req(PASSWORD)), null);
});
