// _fix_bulk_query_multi2.js — fix literal newlines inside join() calls
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');

// Normalize to LF
content = content.replace(/\r\n/g, '\n');

// Fix 1: output.textContent = lines.join('\n'); (in-loop version)
const OLD1 = "                output.textContent = lines.join('\n');\n            }";
const NEW1 = "                output.textContent = lines.join('\\n');\n            }";
if (!content.includes(OLD1)) { console.error('PATCH FAILED: OLD1 not found'); process.exit(1); }
content = content.replace(OLD1, NEW1);

// Fix 2: lines.unshift + final lines.join (end of function)
const OLD2 = "            lines.unshift('Done: ' + okCount + ' OK, ' + failCount + ' failed\n');\n            output.textContent = lines.join('\n');";
const NEW2 = "            lines.unshift('Done: ' + okCount + ' OK, ' + failCount + ' failed\\n');\n            output.textContent = lines.join('\\n');";
if (!content.includes(OLD2)) { console.error('PATCH FAILED: OLD2 not found'); process.exit(1); }
content = content.replace(OLD2, NEW2);

// Convert back to CRLF
content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Fix applied successfully.');
