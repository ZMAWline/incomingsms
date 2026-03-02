#!/usr/bin/env node
// Post-process dashboard after _rebuild_all.js runs.
// Fixes template literal escaping inside getHTML()'s main <script> block.
//
// Usage: node _rebuild_all.js && node _fix_escaping.js

const fs = require('fs');
const path = require('path');
const filePath = path.join(__dirname, 'src', 'dashboard', 'index.js');

let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');
let lines = content.split('\n');

// Find getHTML function
const getHtmlIdx = lines.findIndex(l => l.includes('function getHTML()'));
if (getHtmlIdx === -1) throw new Error('Cannot find getHTML function');

// Find ALL <script> tags inside getHTML, we want the LAST one (the main JS block)
let scriptStartIdx = -1;
let scriptEndIdx = -1;
for (let i = getHtmlIdx; i < lines.length; i++) {
  if (lines[i].trim().startsWith('<script>') && !lines[i].includes('src=')) {
    // Track the last <script> block (not external scripts)
    const endIdx = lines.findIndex((l, j) => j > i && l.trim().startsWith('</script>'));
    if (endIdx !== -1 && (endIdx - i) > 50) {
      // Only consider blocks with 50+ lines (the main JS block)
      scriptStartIdx = i;
      scriptEndIdx = endIdx;
    }
  }
}

if (scriptStartIdx === -1 || scriptEndIdx === -1) throw new Error('Cannot find main <script> block inside getHTML');

console.log(`Escaping template syntax in lines ${scriptStartIdx + 1}-${scriptEndIdx + 1} (${scriptEndIdx - scriptStartIdx - 1} lines)`);

let escapedCount = 0;
for (let i = scriptStartIdx + 1; i < scriptEndIdx; i++) {
  const original = lines[i];
  let line = original;

  // Step 1: Normalize — undo any existing escaping so we have "raw" content
  line = line.replace(/\\`/g, '`');
  line = line.replace(/\\\${/g, '${');

  // Step 2: Re-escape everything for being inside a template literal
  line = line.replace(/`/g, '\\`');
  line = line.replace(/\${/g, '\\${');

  if (line !== original) escapedCount++;
  lines[i] = line;
}

console.log(`Escaped ${escapedCount} lines`);

// Restore CRLF and write
content = lines.join('\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Done! Dashboard file is ready for deployment.');
