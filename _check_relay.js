#!/usr/bin/env node
// _check_relay.js
// Scans all worker source files for bare fetch() calls to external APIs
// that are NOT going through relayFetch.
//
// Run: node _check_relay.js
// Exit code 0 = clean. Exit code 1 = violations found.

const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, 'src');

// Patterns that indicate a fetch() is safe (Supabase, service bindings, relay internals, etc.)
// Checked across a 3-line window (current + 2 lines ahead) to catch multi-line calls.
const SAFE_PATTERNS = [
  'SUPABASE_URL',
  '/rest/v1/',
  'rpc/',
  'functions/v1/',        // Supabase Edge Functions (e.g. skyline-bridge)
  'webhook_deliveries',
  'carrier_api_logs',
  '.fetch(',              // service binding e.g. env.MDN_ROTATOR.fetch(
  'return fetch(url, init)', // relayFetch fallback body
  'return fetch(url,',   // relayFetch fallback body (any variant)
  'RELAY_URL',
  'RELAY_KEY',
  'QBO_TOKENS',
  'TOKEN_CACHE',
  '//',                  // commented out
  'API_BASE',            // browser-side JS
];

const SKIP_DIRS = ['.wrangler', 'node_modules', '.git'];
const SKIP_SHARED = true; // src/shared/ modules are imported; relay lives there

function shouldSkipDir(name) {
  return SKIP_DIRS.some(d => name === d);
}

function getSourceFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (shouldSkipDir(entry.name)) continue;
      if (SKIP_SHARED && entry.name === 'shared') continue;
      results.push(...getSourceFiles(path.join(dir, entry.name)));
    } else if (entry.isFile()) {
      if (!entry.name.endsWith('.js') && !entry.name.endsWith('.ts')) continue;
      // Skip old duplicate .ts files (superseded by .js)
      if (entry.name === 'index.ts') continue;
      results.push(path.join(dir, entry.name));
    }
  }
  return results;
}

function windowIsSafe(lines, idx) {
  // Check a window of lines: 20 back (for variable assignment context) + 2 ahead
  const start = Math.max(0, idx - 20);
  const end = Math.min(idx + 2, lines.length - 1);
  for (let j = start; j <= end; j++) {
    if (SAFE_PATTERNS.some(p => lines[j].includes(p))) return true;
  }
  return false;
}

const files = getSourceFiles(SRC_DIR);
const violations = [];

for (const file of files) {
  const rawContent = fs.readFileSync(file, 'utf8');
  // Strip the frontend JS inside getHTML() to avoid false positives from browser fetch() calls
  let content = rawContent;
  const getHtmlStart = content.indexOf('function getHTML()');
  if (getHtmlStart !== -1) {
    content = content.slice(0, getHtmlStart);
  }

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/\bfetch\s*\(/.test(line)) continue;
    if (!/\bawait\s+fetch\s*\(|return\s+fetch\s*\(/.test(line)) continue;
    if (windowIsSafe(lines, i)) continue;

    violations.push({
      file: path.relative(__dirname, file),
      line: i + 1,
      text: line.trim(),
    });
  }
}

if (violations.length === 0) {
  console.log('✓ relay check passed — no bare external fetch() calls found');
  process.exit(0);
} else {
  console.error(`✗ relay check FAILED — ${violations.length} bare fetch() call(s) found:\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    ${v.text}\n`);
  }
  console.error('Each of these must use relayFetch(env, url, init) instead.');
  console.error('See agent/constraints.md §11 for the pattern.');
  process.exit(1);
}
