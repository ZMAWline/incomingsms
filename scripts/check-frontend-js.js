// Syntax-checks inline and local classic JS from src/dashboard/public/index.html.
//
// The SPA was extracted out of the old getHTML() template literal on
// 2026-06-12, so public/index.html is a plain file — no CRLF, no nested
// template escaping. This reads inline blocks and local assets and runs
// `node --check` over it, which is what actually catches a broken build
// before it reaches the browser.
//
// Run from anywhere: `node scripts/check-frontend-js.js`.
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const { readDashboardScripts } = require('./dashboard-scripts.cjs');
const blocks = readDashboardScripts(path.join(__dirname, '..', 'src', 'dashboard', 'public', 'index.html'));
if (blocks.length === 0) {
  console.error('No classic scripts found — did the file move?');
  process.exit(1);
}

let failed = 0;
blocks.forEach(({ source, filename }, i) => {
  const tmp = path.join(os.tmpdir(), `frontend_check_${process.pid}_${i}.js`);
  // The shared loader substitutes the server-injected feature placeholder.
  fs.writeFileSync(tmp, source, 'utf8');
  try {
    cp.execFileSync(process.execPath, ['--check', tmp], { stdio: 'inherit' });
  } catch (e) {
    console.error(`Frontend JS ${filename} has syntax errors.`);
    failed++;
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) {}
  }
});

if (failed) process.exit(1);
console.log(`Frontend JS syntax OK (${blocks.length} inline/local classic script(s))`);
