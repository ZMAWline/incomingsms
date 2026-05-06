// Fix the newlines in the Wing IoT query - must be \\n not actual newlines
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');

// Normalize to LF for reliable search/replace
content = content.replace(/\r\n/g, '\n');

// The problem: \n in the patch became actual newlines
// We need to find the broken lines and fix them

// Fix 1: The Wing IoT formatted string with broken newlines
const brokenFormatted1 = `let formatted = '<span class="text-green-400 font-bold">Wing IoT Device Found</span>

';`;

const fixedFormatted1 = `let formatted = '<span class="text-green-400 font-bold">Wing IoT Device Found</span>' + '\\n\\n';`;

if (content.includes(brokenFormatted1)) {
  content = content.replace(brokenFormatted1, fixedFormatted1);
  console.log('Fixed: Wing IoT Device Found newlines');
} else {
  console.log('Pattern 1 not found - checking alternate');
}

// Fix 2: All the formatted += lines with broken newlines
// Pattern: ends with + '\n' but the \n became actual newline
const brokenPatterns = [
  [`formatted += '<span class="text-blue-400">status:</span> ' + (data.status || 'N/A') + '
';`, `formatted += '<span class="text-blue-400">status:</span> ' + (data.status || 'N/A') + '\\n';`],
  [`formatted += '<span class="text-blue-400">mdn:</span> ' + (data.mdn || 'N/A') + '
';`, `formatted += '<span class="text-blue-400">mdn:</span> ' + (data.mdn || 'N/A') + '\\n';`],
  [`formatted += '<span class="text-blue-400">communicationPlan:</span> ' + (data.communicationPlan || 'N/A') + '
';`, `formatted += '<span class="text-blue-400">communicationPlan:</span> ' + (data.communicationPlan || 'N/A') + '\\n';`],
  [`formatted += '<span class="text-blue-400">customer:</span> ' + (data.customer || '(blank)') + '
';`, `formatted += '<span class="text-blue-400">customer:</span> ' + (data.customer || '(blank)') + '\\n';`],
  [`formatted += '
<span class="text-gray-500">--- Full Response ---</span>
';`, `formatted += '\\n<span class="text-gray-500">--- Full Response ---</span>\\n';`],
  [`outputEl.innerHTML = '<span class="text-red-400">Wing IoT Error (HTTP ' + result.status + '):</span>
' + JSON.stringify(result.response, null, 2);`, `outputEl.innerHTML = '<span class="text-red-400">Wing IoT Error (HTTP ' + result.status + '):</span>\\n' + JSON.stringify(result.response, null, 2);`]
];

for (const [broken, fixed] of brokenPatterns) {
  if (content.includes(broken)) {
    content = content.replace(broken, fixed);
    console.log('Fixed a broken newline pattern');
  }
}

// Convert back to CRLF
content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Newline fix complete.');
