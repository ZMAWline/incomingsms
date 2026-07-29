import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard', 'index.js'), 'utf8');
const DASHBOARD_HTML = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard', 'public', 'index.html'), 'utf8');

test('dashboard exposes bad-rental rerun-auto API route and safe patch semantics', () => {
  assert.match(DASHBOARD_SRC, /\/api\/bad-rentals\/.*\/rerun-auto/);
  assert.match(DASHBOARD_SRC, /handleBadRentalRerunAuto/);
  assert.match(DASHBOARD_SRC, /auto_remediation_state:\s*'queued'/);
  assert.match(DASHBOARD_SRC, /last_auto_attempt_at:\s*null/);
  assert.match(DASHBOARD_SRC, /escalation_reason:\s*null/);
  assert.match(DASHBOARD_SRC, /source:\s*'dashboard_rerun_auto'/);
  assert.match(DASHBOARD_SRC, /report is not open/);
});

test('bad-rentals UI has escalated-row rerun auto control', () => {
  assert.match(DASHBOARD_HTML, /autoState === 'escalated'/);
  assert.match(DASHBOARD_HTML, /Rerun auto/);
  assert.match(DASHBOARD_HTML, /rerunBadRentalAuto/);
  assert.match(DASHBOARD_HTML, /\/rerun-auto/);
  assert.match(DASHBOARD_HTML, /eligible for the next reviewer tick/);
});
