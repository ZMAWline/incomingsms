// Regression test: dashboard-test proxies SIM activation to bulk-activator-test
// over a service binding, but bulk-activator-test is deployed by a separate
// Cloudflare Workers Build pipeline that tracks production, not PR branches.
// A PR-only fix to src/bulk-activator (e.g. the /activate JSON-401 fix) could
// silently never reach the shared preview, so the dashboard-test preview would
// keep exercising a stale bulk-activator-test — exactly what produced
// "Worker returned non-JSON response (401): Unauthorized" on PR #69's preview.
// This asserts the shared-preview workflow keeps bulk-activator-test deployed
// and verified alongside dashboard-test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(
  new URL('../.github/workflows/dashboard-pr-preview.yml', import.meta.url),
  'utf8'
);

test('shared preview workflow triggers on src/bulk-activator changes', () => {
  assert.match(workflow, /paths:[\s\S]*?- 'src\/bulk-activator\/\*\*'/);
});

test('shared preview workflow deploys bulk-activator to its test environment', () => {
  assert.match(
    workflow,
    /wrangler deploy --config src\/bulk-activator\/wrangler\.toml --env test(?!\s*--dry-run)/
  );
});

test('shared preview workflow smoke-tests that bulk-activator-test returns JSON on auth failure', () => {
  assert.match(workflow, /BULK_ACTIVATOR_TEST_URL:\s*https:\/\/bulk-activator-test\.zalmen-531\.workers\.dev/);
  assert.match(workflow, /\$BULK_ACTIVATOR_TEST_URL\/activate/);
  assert.match(workflow, /d\.get\('ok'\) is False/);
});
