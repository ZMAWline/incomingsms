const fs = require('fs');
const vm = require('vm');
const cp = require('child_process');

const src = fs.readFileSync('src/reseller-portal/index.js','utf8');
const start = src.indexOf('function portalHtml()');
if (start === -1) { console.error('portalHtml not found'); process.exit(1); }

let depth = 0, i = start, started = false;
while (i < src.length) {
  if (src[i] === '{') { depth++; started = true; }
  if (src[i] === '}') { depth--; if (started && depth === 0) break; }
  i++;
}
const fnSrc = src.slice(start, i + 1);
const ctx = vm.createContext({});
const fn = vm.runInContext('(' + fnSrc + ')', ctx);
const html = fn();
const a = html.lastIndexOf('<script>');
const b = html.lastIndexOf('</script>');
if (a === -1 || b === -1) { console.error('no <script> tag'); process.exit(1); }
const js = html.slice(a + 8, b);
fs.writeFileSync('_portal_frontend_tmp.js', js);
try {
  cp.execSync('node --check < _portal_frontend_tmp.js', { stdio: 'inherit', shell: true });
  console.log('Portal frontend JS OK (' + js.length + ' bytes)');
} catch (e) { process.exit(1); }
finally { try { fs.unlinkSync('_portal_frontend_tmp.js'); } catch (e) {} }
