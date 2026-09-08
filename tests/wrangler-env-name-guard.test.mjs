// Guards against the 2026-09-08 CI breakage (fixed in PR #73).
//
// `wrangler ... --env test --name dashboard-test` does NOT target the worker
// called `dashboard-test`. Wrangler appends the environment suffix to an
// explicit `--name`, so the command targeted a phantom `dashboard-test-test`.
// Cloudflare answers a write to a nonexistent script with
// `Invalid access token [code: 9109]` / `Authentication error [code: 10000]`,
// which reads like an expired credential and sent one session off to rotate a
// working token. Nothing in the error mentions the real problem.
//
// Rule: pick ONE. Either resolve the worker from `[env.<name>]` in the config
// (`--config path/wrangler.toml --env test`) or name it outright (`--name x`).
// Never both on the same command.

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const WORKFLOW_DIR = '.github/workflows';

function wranglerCommands(text) {
  // Join YAML line continuations so a wrapped command is checked as one unit.
  const flat = text.replace(/\\\r?\n\s*/g, ' ');
  return flat
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => !line.startsWith('#'))
    .filter((line) => /\bwrangler\b/.test(line));
}

test('no CI wrangler command combines --env with an explicit --name', () => {
  const files = readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  assert.ok(files.length > 0, 'expected at least one workflow file to scan');

  const offenders = [];
  for (const file of files) {
    const text = readFileSync(join(WORKFLOW_DIR, file), 'utf8');
    for (const cmd of wranglerCommands(text)) {
      if (/--env(\s|=)/.test(cmd) && /--name(\s|=)/.test(cmd)) {
        offenders.push(`${file}: ${cmd}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'wrangler appends the --env suffix to an explicit --name, targeting a phantom worker. ' +
      'Drop --name and let --config + --env resolve the target:\n' + offenders.join('\n')
  );
});

test('the workflow scanner actually recognises the shape it is guarding against', () => {
  // Without this, a broken regex would make the guard above silently vacuous.
  const sample = [
    'jobs:',
    '  - run: npx wrangler secret put X --env test --name dashboard-test',
  ].join('\n');
  const found = wranglerCommands(sample).filter(
    (c) => /--env(\s|=)/.test(c) && /--name(\s|=)/.test(c)
  );
  assert.equal(found.length, 1, 'scanner must flag the exact command that broke CI');
});

test('scanner ignores commented-out examples of the bad pattern', () => {
  // PR #73 left the bad command quoted in a comment as documentation. That
  // must not trip the guard, or the fix would fail its own test.
  const sample = '  # `--env test --name dashboard-test` made wrangler append the suffix';
  assert.equal(wranglerCommands(sample).length, 0);
});
