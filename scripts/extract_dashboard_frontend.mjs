#!/usr/bin/env node
// One-time migration tool (kept for provenance): extracts the dashboard
// frontend out of the getHTML() template literal in src/dashboard/index.js
// into a real static file, src/dashboard/public/index.html.
//
// Method: import the module and CALL getHTML() — i.e. render exactly the
// bytes production serves today — rather than hand-parsing template-literal
// escapes (the source of the old _fix_*.js patch-script ritual). The single
// server-side interpolation (window.HELIX_ENABLED) becomes the
// __HELIX_ENABLED__ placeholder, substituted by the worker at request time.
//
// Usage: node scripts/extract_dashboard_frontend.mjs

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcPath = join(root, 'src/dashboard/index.js');
const tmpPath = join(root, 'src/dashboard/_extract_tmp.mjs');
const outDir  = join(root, 'src/dashboard/public');

const src = readFileSync(srcPath, 'utf8');
if (!src.includes('function getHTML(helixEnabled)')) {
  console.error('getHTML(helixEnabled) not found — already extracted?');
  process.exit(1);
}

// Re-export the module-scope function so Node can call it. Strip the
// worker-only imports — getHTML() has no dependency on them, and Node's
// CJS/ESM interop chokes on the .js shared modules (package type=commonjs).
const stripped = src.replace(/^import .*$/gm, '// [extract] import stripped');
writeFileSync(tmpPath, stripped + '\nexport { getHTML as __extract_getHTML };\n');

try {
  const mod = await import(tmpPath);
  const htmlTrue  = mod.__extract_getHTML(true);
  const htmlFalse = mod.__extract_getHTML(false);

  // Safety: the ONLY difference between the two renders must be the flag line.
  const expectTrue  = 'window.HELIX_ENABLED = true;';
  const expectFalse = 'window.HELIX_ENABLED = false;';
  if (htmlTrue.replace(expectTrue, '@@FLAG@@') !== htmlFalse.replace(expectFalse, '@@FLAG@@')) {
    console.error('FATAL: renders differ beyond the HELIX_ENABLED line — more server interpolation exists than expected. Aborting.');
    process.exit(1);
  }
  const occurrences = htmlTrue.split(expectTrue).length - 1;
  if (occurrences !== 1) {
    console.error(`FATAL: expected exactly 1 HELIX_ENABLED line, found ${occurrences}. Aborting.`);
    process.exit(1);
  }

  const out = htmlTrue
    .replace(expectTrue, 'window.HELIX_ENABLED = __HELIX_ENABLED__;')
    .replace(/\r\n/g, '\n'); // normalize CRLF (harmless in HTML, saner in git)

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'index.html'), out);
  console.log(`Wrote ${join(outDir, 'index.html')} (${out.length.toLocaleString()} chars, ${out.split('\n').length.toLocaleString()} lines)`);
} finally {
  rmSync(tmpPath, { force: true });
}
