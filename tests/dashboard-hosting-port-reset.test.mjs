import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const dashboard = fs.readFileSync(new URL('../src/dashboard/index.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../src/dashboard/public/index.html', import.meta.url), 'utf8');

test('dashboard has a separate hosting-port reset action for Atomic Teltik SIMs', () => {
  assert.match(dashboard, /action === ['"]reset_hosting_port['"]/);
  assert.match(dashboard, /gateway_host === ['"]teltik['"]/);
  assert.doesNotMatch(dashboard, /reset_hosting_port[\s\S]{0,200}vendor === ['"]atomic['"]/, 'reset must not be limited to Atomic');
  assert.match(dashboard, /v1\/reset-port/);
});

test('Port Status action resets only SIMs whose fresh check is offline', () => {
  assert.match(html, /data\.results\s*\|\|\s*\[\]/);
  assert.match(html, /r\.state\s*===\s*['"]offline['"]/);
  assert.match(html, /reset_hosting_port/);
});
