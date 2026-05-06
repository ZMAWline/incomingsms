// Fix unescaped backticks and ${ in the queryHelix/queryHelixBulk block
const fs = require('fs');
const p = require('path').join(__dirname, 'src/dashboard/index.js');
let c = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

const blockStart = c.indexOf('        async function queryHelix() {');
const blockEnd = c.indexOf('\n        async function showTestSmsModal() {');

if (blockStart === -1 || blockEnd === -1) {
  console.error('Block boundaries not found:', blockStart, blockEnd);
  process.exit(1);
}

let block = c.slice(blockStart, blockEnd);

// Count bare backticks before fix
const bareBefore = (block.match(/(?<!\\)`/g) || []).length;
console.log('Bare backticks found:', bareBefore);

// Escape bare backticks (not already escaped)
block = block.replace(/(?<!\\)`/g, '\\`');

// Escape bare ${ (not already escaped)
block = block.replace(/(?<!\\)\$\{/g, '\\${');

// Guard against double-escaping
if (block.includes('\\\\`') || block.includes('\\\\${')) {
  console.error('Double escaping detected! Aborting.');
  process.exit(1);
}

const bareAfter = (block.match(/(?<!\\)`/g) || []).length;
console.log('Bare backticks after:', bareAfter);

c = c.slice(0, blockStart) + block + c.slice(blockEnd);
fs.writeFileSync(p, c.replace(/\n/g, '\r\n'), 'utf8');
console.log('Done.');
