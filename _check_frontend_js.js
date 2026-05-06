const fs = require('fs'), cp = require('child_process'), vm = require('vm');
const src = fs.readFileSync('src/dashboard/index.js', 'utf8');
const start = src.indexOf('function getHTML(');
if (start === -1) { console.error('getHTML not found'); process.exit(1); }
let depth = 0, i = start, bodyStarted = false;
while (i < src.length) {
  const c = src[i];
  if (c === '{') { depth++; bodyStarted = true; }
  if (c === '}') { if (--depth === 0 && bodyStarted) break; }
  i++;
}
const fn = vm.runInContext('(' + src.slice(start, i + 1) + ')', vm.createContext({}));
const html = fn();
const scriptStart = html.lastIndexOf('<script>');
const scriptEnd = html.lastIndexOf('</script>');
if (scriptStart === -1) { console.error('script tag not found'); process.exit(1); }
const browserJs = html.slice(scriptStart + 8, scriptEnd);
fs.writeFileSync('_frontend_check_tmp.js', browserJs, 'utf8');
try {
  cp.execSync('node --check < _frontend_check_tmp.js', { stdio: ['inherit', 'inherit', 'inherit'], shell: true });
  console.log('Frontend JS syntax OK');
} catch (e) {
  console.error('Frontend JS has syntax errors!');
  process.exit(1);
} finally {
  try { fs.unlinkSync('_frontend_check_tmp.js'); } catch (e) {}
}
