// _dedup_kasa.js — remove duplicate kasa additions from double-patch
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

// ── Dedup: duplicate loadKasaOutlets + kasaControl (old style before kasaKick) ──
// The second run added kasaKick + new functions. The first run added old functions
// without kasaKick. Remove the first (old) set by removing from first loadKasaOutlets
// up to (but not including) kasaKick.
const OLD_SET_MARKER = '\n        async function loadKasaOutlets() {';
const NEW_SET_MARKER = '\n        function kasaKick(el) {';

const oldSetIdx = content.indexOf(OLD_SET_MARKER);
const newSetIdx = content.indexOf(NEW_SET_MARKER);

if (oldSetIdx !== -1 && newSetIdx !== -1 && oldSetIdx < newSetIdx) {
  content = content.slice(0, oldSetIdx) + content.slice(newSetIdx);
  console.log('Dedup OK (removed old loadKasaOutlets/kasaControl before kasaKick)');
  content = content.replace(/\n/g, '\r\n');
  fs.writeFileSync(filePath, content, 'utf8');
  console.log('File written.');
} else {
  console.log('Nothing to dedup (oldSetIdx=' + oldSetIdx + ', newSetIdx=' + newSetIdx + ')');
}
