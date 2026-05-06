// Find single-backslash \n/\t/\r inside the frontend JS section of index.js
// These will be evaluated by getHTML()'s template literal into literal chars → browser syntax error
const fs = require('fs');
const content = fs.readFileSync('src/dashboard/index.js', 'utf8').replace(/\r\n/g, '\n');

const frontendStart = content.indexOf('\n    <script>\n        const API_BASE');
const frontendEnd = content.lastIndexOf('</script>');
const frontend = content.slice(frontendStart, frontendEnd);

console.log('Frontend section:', frontendStart, '-', frontendEnd, '(', frontend.length, 'chars)');

const BACKSLASH = 92; // \
const issues = [];

for (let i = 0; i < frontend.length - 1; i++) {
  const code = frontend.charCodeAt(i);
  const next = frontend.charCodeAt(i + 1);
  if (code === BACKSLASH) {
    const prev = i > 0 ? frontend.charCodeAt(i - 1) : 0;
    // Check if this is a single backslash (not a double backslash)
    if (prev !== BACKSLASH) {
      // It's a single backslash — what follows?
      if (next === 110 || next === 116 || next === 114) { // n, t, r
        const ctx = frontend.slice(Math.max(0, i - 40), i + 40);
        issues.push({ pos: frontendStart + i, nextChar: String.fromCharCode(next), ctx });
      }
    }
  }
}

console.log('Single-backslash \\n/\\t/\\r found:', issues.length);
issues.forEach((m, idx) => {
  console.log(`\n[${idx}] pos=${m.pos} next=\\${m.nextChar}`);
  console.log('  ctx:', JSON.stringify(m.ctx));
});
