// _fix_helix_interpolation.js
// Fix: \${helixEnabled} is escaped, preventing template interpolation.
// The deployed HTML outputs literal ${helixEnabled} which is a ReferenceError
// that kills the script block and breaks toggleSidebar (hamburger menu).
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');

// Normalize to LF for reliable search/replace
content = content.replace(/\r\n/g, '\n');

// The old string has a backslash before ${helixEnabled} — escaping the interpolation
const OLD = 'window.HELIX_ENABLED = \\${helixEnabled};';
// The new string removes the backslash so the template literal interpolates the value
const NEW = 'window.HELIX_ENABLED = ${helixEnabled};';

if (!content.includes(OLD)) {
  console.error('PATCH FAILED: old string not found. File may have changed.');
  process.exit(1);
}
content = content.replace(OLD, NEW);

// Convert back to CRLF
content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch applied successfully.');
