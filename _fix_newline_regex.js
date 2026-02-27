'use strict';
// Fix: /\n/ in getHTML() template literal → actual newline in output → browser SyntaxError
// The regex in raw.split(/\n/) needs to be \\n in source so template literal emits \n
// Run: node _fix_newline_regex.js

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src', 'dashboard', 'index.js');
let src = fs.readFileSync(filePath, 'utf8');

// Normalize to LF
src = src.replace(/\r\n/g, '\n');

// The source file currently has:
//   raw.split(/\n/)   <-- \n is backslash+n (two chars), inside template literal → becomes newline → browser SyntaxError
// It needs to be:
//   raw.split(/\\n/)  <-- \\n is backslash+backslash+n (three chars), template literal emits \n → browser sees /\n/ ✓

const OLD = 'const imeis = raw.split(/\\n/).map(function(s) { return s.trim(); }).filter(function(s) { return s.length > 0; });';
const NEW = 'const imeis = raw.split(/\\\\n/).map(function(s) { return s.trim(); }).filter(function(s) { return s.length > 0; });';

if (!src.includes(OLD)) {
  console.error('ERROR: target line not found — already fixed or different content');
  console.error('Searching for:', OLD);
  process.exit(1);
}

src = src.replace(OLD, NEW);
console.log('✓ Fixed /\\n/ → /\\\\n/ in runBulkImeiCheck');

// Write with CRLF
const out = src.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, out, 'utf8');
console.log('✓ Written src/dashboard/index.js with CRLF line endings');
