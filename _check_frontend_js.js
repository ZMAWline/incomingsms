// _check_frontend_js.js — extract browser-side JS from getHTML() and syntax-check it
// Uses the Worker module itself to get the exact string that the browser would receive
const fs = require('fs');
const cp = require('child_process');

// Strategy: execute the getHTML() function in Node to get the actual HTML string,
// then extract the script tag content — this is exactly what the browser receives.
const workerCode = fs.readFileSync('src/dashboard/index.js', 'utf8');

// getHTML() is a plain function that returns a template literal string.
// Extract just the getHTML function and eval it.
const fnStart = workerCode.indexOf('\nfunction getHTML()');
const fnEnd = workerCode.indexOf('\n// End of file', fnStart); // fallback
// Find the end: the function ends at the last `}` at module level
// Actually just eval the whole file as CJS by wrapping in a function scope
// Safer: extract just the getHTML function body
const start = workerCode.indexOf('function getHTML() {');
if (start === -1) { console.error('getHTML() not found'); process.exit(1); }

// Find the closing brace of getHTML by counting braces
let depth = 0, i = start;
let inString = false, strChar = '', escape = false;
let inTemplateLiteral = 0; // depth counter for template literals
let bodyStart = -1;
while (i < workerCode.length) {
  const c = workerCode[i];
  if (bodyStart === -1 && c === '{') { depth = 1; bodyStart = i; i++; continue; }
  if (bodyStart !== -1) {
    if (c === '{') depth++;
    if (c === '}') { depth--; if (depth === 0) break; }
  }
  i++;
}
const getHTMLSrc = workerCode.slice(start, i + 1);

// Use Node's vm to execute it and get the HTML
const vm = require('vm');
const ctx = vm.createContext({});
const fn = vm.runInContext('(' + getHTMLSrc + ')', ctx);
const html = fn();

// Extract the last <script> block
const scriptStart = html.lastIndexOf('<script>');
const scriptEnd = html.lastIndexOf('</script>');
if (scriptStart === -1 || scriptEnd === -1) {
  console.error('ERROR: <script> tags not found in getHTML() output');
  process.exit(1);
}

const browserJs = html.slice(scriptStart + 8, scriptEnd);
console.log('Extracted browser JS:', browserJs.length, 'chars');

// Write to temp file for syntax checking
fs.writeFileSync('_frontend_check_tmp.js', browserJs, 'utf8');

try {
  cp.execSync('node --check < _frontend_check_tmp.js', {
    stdio: ['inherit', 'inherit', 'inherit'],
    shell: true
  });
  console.log('Frontend JS syntax OK');
} catch (e) {
  console.error('Frontend JS has syntax errors! Check _frontend_check_tmp.js for line numbers.');
  process.exit(1);
} finally {
  try { fs.unlinkSync('_frontend_check_tmp.js'); } catch(e) {}
}
