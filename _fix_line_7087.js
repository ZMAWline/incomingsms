// Fix line 7087
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');

content = content.replace(/\r\n/g, '\n');

// The line has single quotes with \n inside
const old = `formatted += '\\n<span class="text-gray-500">--- Full Response ---</span>\\n';`;
const fixed = `formatted += '\\\\n<span class="text-gray-500">--- Full Response ---</span>\\\\n';`;

if (content.includes(old)) {
  content = content.replace(old, fixed);
  console.log('Fixed line 7087');
} else {
  console.log('Pattern not found, showing context:');
  const idx = content.indexOf('Full Response');
  if (idx > -1) {
    console.log(content.slice(idx - 50, idx + 100));
  }
}

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
