// Fix the Wing IoT formatted strings - need \\n not \n
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');

// Normalize to LF
content = content.replace(/\r\n/g, '\n');

// Find and fix the Wing IoT query section
// The \n in strings need to be \\n for proper escaping inside getHTML template

// Fix 1: Wing IoT Device Found line
const old1 = `let formatted = '<span class="text-green-400 font-bold">Wing IoT Device Found</span>\\n\\n';`;
const new1 = `let formatted = '<span class="text-green-400 font-bold">Wing IoT Device Found</span>\\\\n\\\\n';`;

if (content.includes(old1)) {
  content = content.replace(old1, new1);
  console.log('Fixed: Wing IoT Device Found');
} else {
  console.log('Pattern 1 not found');
}

// Fix 2-5: The status/mdn/etc lines
const fixes = [
  [`+ '\\n';`, `+ '\\\\n';`],
  [`+ '\\n<span class="text-gray-500">--- Full Response ---</span>\\n';`, `+ '\\\\n<span class="text-gray-500">--- Full Response ---</span>\\\\n';`],
  [`'):</span>\\n' + JSON.stringify`, `'):</span>\\\\n' + JSON.stringify`]
];

for (const [old, newStr] of fixes) {
  while (content.includes(old)) {
    content = content.replace(old, newStr);
    console.log('Fixed:', old.slice(0, 30));
  }
}

// Convert back to CRLF
content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Escape fix complete.');
