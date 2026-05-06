'use strict';
const fs = require('fs');
const src = fs.readFileSync('src/dashboard/index.js', 'utf8');
// Make it require-able by stripping the export
const mod = src.replace('export default {', 'module.exports = {');
fs.writeFileSync('_dash_tmp.js', mod);
const worker = require('./_dash_tmp.js');
const html = worker.fetch ? '(no getHTML)' : null;

// Actually, getHTML is a local function — eval the file differently
// Find and eval getHTML
const match = src.match(/function getHTML\(\) \{[\s\S]*?^\}/m);
console.log('getHTML found via regex:', !!match);

// Better: just require the modified file and call getHTML
// Since getHTML is not exported, we need to add an export
const src2 = src
  .replace('export default {', '// export default {')
  .replace(/^\}$/m, '// }')
  + '\nif (typeof getHTML === "function") { module.exports = { getHTML }; }';
fs.writeFileSync('_dash_tmp2.js', src2);
try {
  const m2 = require('./_dash_tmp2.js');
  const html2 = m2.getHTML();
  // Extract largest script tag
  const scripts = [];
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let sc;
  while ((sc = re.exec(html2)) !== null) scripts.push(sc[1]);
  scripts.sort((a,b) => b.length - a.length);
  fs.writeFileSync('_dash_script_extracted.js', scripts[0]);
  console.log('Extracted script:', scripts[0].length, 'chars');
} catch(e) {
  console.error('Error:', e.message);
}
