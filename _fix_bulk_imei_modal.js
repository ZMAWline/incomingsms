// _fix_bulk_imei_modal.js — fix \n escaping in lines.join calls
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

// OLD: '\n' (single backslash + n) — gets evaluated as newline inside template, breaks JS
// NEW: '\\n' (double backslash + n) — evaluated as \n escape sequence, valid JS
const OLD_PROGRESS = "                    output.textContent = lines.join('\\n') + '\\n\\nProcessing... (' + (ok + fail) + '/' + simIds.length + ')';";
const OLD_DONE     = "                output.textContent = lines.join('\\n') + '\\n\\nDone: ' + ok + ' success, ' + fail + ' failed';";

// "double-backslash-n" in the file = \\n → inside template evaluates to \n ✓
const NEW_PROGRESS = "                    output.textContent = lines.join('\\\\n') + '\\\\n\\\\nProcessing... (' + (ok + fail) + '/' + simIds.length + ')';";
const NEW_DONE     = "                output.textContent = lines.join('\\\\n') + '\\\\n\\\\nDone: ' + ok + ' success, ' + fail + ' failed';";

if (!content.includes(OLD_PROGRESS)) {
  console.error('PATCH FAILED: progress line not found');
  console.error('Looking for:', JSON.stringify(OLD_PROGRESS));
  // Show what's around line 10105
  const idx = content.indexOf("lines.join('\\n') + '\\n\\nProcessing");
  if (idx !== -1) console.error('Found similar at:', JSON.stringify(content.slice(idx - 20, idx + 80)));
  process.exit(1);
}
if (!content.includes(OLD_DONE)) {
  console.error('PATCH FAILED: done line not found');
  process.exit(1);
}

content = content.replace(OLD_PROGRESS, NEW_PROGRESS);
content = content.replace(OLD_DONE, NEW_DONE);

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch applied successfully.');
