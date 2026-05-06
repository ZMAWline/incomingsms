// Fix: dbLines.join('\n') — \n inside single-quoted string becomes literal newline → syntax error
// Need \\n (double backslash) so template literal evaluates to \n (backslash+n) in output
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

// OLD: dbLines.join('\n') — \n is two chars (92,110) = evaluated to newline by template
// NEW: dbLines.join('\\n') — \\n is three chars (92,92,110) = evaluated to \n (backslash+n) by template
const OLD = "dbOutput.textContent = dbLines.join('\\n');";
const NEW = "dbOutput.textContent = dbLines.join('\\\\n');";

if (!content.includes(OLD)) {
  console.error('PATCH FAILED: old string not found');
  console.error('Looking for:', JSON.stringify(OLD));
  process.exit(1);
}
content = content.replace(OLD, NEW);
console.log('Fixed dbLines.join newline escape');

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch applied.');
