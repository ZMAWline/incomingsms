// _fix_sms_usage_01_head.js
// Insert Chart.js CDN script after Tailwind CDN script in <head>.
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

const OLD = '<script src="https://cdn.tailwindcss.com"></script>';
const NEW = '<script src="https://cdn.tailwindcss.com"></script>\n    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js" defer></script>';

if (!content.includes(OLD)) {
  console.error('PATCH FAILED: Tailwind CDN line not found.');
  process.exit(1);
}
if (content.includes('chart.umd.min.js')) {
  console.error('PATCH FAILED: Chart.js already present.');
  process.exit(1);
}
content = content.replace(OLD, () => NEW);

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch 1 applied: Chart.js CDN inserted after Tailwind.');
