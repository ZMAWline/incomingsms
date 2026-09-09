// Syntax-checks the frontend JS inside src/dashboard/public/index.html.
//
// The SPA was extracted out of the old getHTML() template literal on
// 2026-06-12, so public/index.html is a plain file — no CRLF, no nested
// template escaping. This just pulls every <script> block and runs
// `node --check` over it, which is what actually catches a broken build
// before it reaches the browser.
const fs = require('fs');
const cp = require('child_process');

const html = fs.readFileSync('src/dashboard/public/index.html', 'utf8');
const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
if (blocks.length === 0) {
  console.error('No inline <script> blocks found — did the file move?');
  process.exit(1);
}

let failed = 0;
blocks.forEach(([, body], i) => {
  const tmp = `_frontend_check_${i}.js`;
  // The one server-injected placeholder is not valid JS on its own.
  fs.writeFileSync(tmp, body.replace('__HELIX_ENABLED__', 'false'), 'utf8');
  try {
    cp.execSync(`node --check ${tmp}`, { stdio: ['inherit', 'inherit', 'inherit'] });
  } catch (e) {
    console.error(`Frontend JS block #${i} has syntax errors.`);
    failed++;
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) {}
  }
});

if (failed) process.exit(1);
console.log(`Frontend JS syntax OK (${blocks.length} inline script block(s))`);
