// _fix_bulk_query_multi3.js — fix single-backslash \n to double \\ in join calls
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');

// Normalize to LF
content = content.replace(/\r\n/g, '\n');

// The broken lines have join('\n') where \n is backslash+n (single backslash).
// The working pattern is join('\\n') — double backslash+n.
// In JS strings: '\n' = newline char, '\\n' = backslash+n literal.
// We want to replace the single-backslash form with the double-backslash form.

// OLD: lines.join('\n');   (single backslash — produces newline in template literal)
// NEW: lines.join('\\n');  (double backslash — produces \n escape in browser JS)

// In this patch script string, to represent a single backslash+n: '\n' is newline, '\\n' is backslash+n.
// So OLD content in file = join('\n') where \n is a real backslash followed by n.
// In this patch script: that's join('\\n') as a JS string.
// NEW content = join('\\\\n') as a JS string = join('\\n') in the file.

const OLD_LOOP = "                output.textContent = lines.join('\\n');\n            }";
const NEW_LOOP  = "                output.textContent = lines.join('\\\\n');\n            }";

const OLD_FINAL_JOIN = "            output.textContent = lines.join('\\n');\n        }";
const NEW_FINAL_JOIN  = "            output.textContent = lines.join('\\\\n');\n        }";

const OLD_UNSHIFT = "            lines.unshift('Done: ' + okCount + ' OK, ' + failCount + ' failed\\n');";
const NEW_UNSHIFT  = "            lines.unshift('Done: ' + okCount + ' OK, ' + failCount + ' failed\\\\n');";

if (!content.includes(OLD_LOOP)) { console.error('PATCH FAILED: OLD_LOOP not found'); process.exit(1); }
content = content.replace(OLD_LOOP, NEW_LOOP);

if (!content.includes(OLD_FINAL_JOIN)) { console.error('PATCH FAILED: OLD_FINAL_JOIN not found'); process.exit(1); }
content = content.replace(OLD_FINAL_JOIN, NEW_FINAL_JOIN);

if (!content.includes(OLD_UNSHIFT)) { console.error('PATCH FAILED: OLD_UNSHIFT not found'); process.exit(1); }
content = content.replace(OLD_UNSHIFT, NEW_UNSHIFT);

// Convert back to CRLF
content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Fix applied successfully.');
