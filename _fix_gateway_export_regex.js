// _fix_gateway_export_regex.js
// Fix: the \n\r in a regex char class inside exportGatewayTable() became literal
// newlines in the output (template literal evaluated \n/\r as escape sequences),
// producing an invalid regex literal spanning multiple lines. We need \\n\\r in the
// source file so the browser JS receives literal `\n\r` chars.
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');

// Normalize to LF for reliable search/replace
content = content.replace(/\r\n/g, '\n');

// The broken regex currently spans three lines after template-literal evaluation.
// In the source file right now, the pattern actually reads:
//     return /[",\n\r]/.test(s) ? ...
// where the backslashes are escape sequences. We need the source to read:
//     return /[",\\n\\r]/.test(s) ? ...
// so that after \\n → \n (one escape level), the browser JS receives the literal
// two chars \ + n (a valid regex escape).
const OLD = 'return /[",\\n\\r]/.test(s) ? \'"\' + s.replace(/"/g, \'""\') + \'"\' : s;';
const NEW = 'return /[",\\\\n\\\\r]/.test(s) ? \'"\' + s.replace(/"/g, \'""\') + \'"\' : s;';

if (!content.includes(OLD)) {
  console.error('PATCH FAILED: old string not found (file may have changed).');
  process.exit(1);
}
content = content.replace(OLD, NEW);

// Convert back to CRLF
content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch applied successfully.');
