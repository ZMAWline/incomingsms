const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, 'src/dashboard/index.js');
let src = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

// 1. Add normalizePastedSearch function right after matchesSearch
// Uses String.fromCharCode() — zero escape sequences, safe inside template literal
const OLD_FN = `        function matchesSearch(obj, query) {`;
const NEW_FN = `        function normalizePastedSearch(el, e, cb) {
            var NL = String.fromCharCode(10);
            var CR = String.fromCharCode(13);
            var text = (e.clipboardData||window.clipboardData).getData('text');
            if (text.indexOf(NL) === -1 && text.indexOf(CR) === -1) return;
            e.preventDefault();
            var normalized = text.split(new RegExp('[' + CR + NL + ']+')).map(function(s){return s.trim();}).filter(Boolean).join(',');
            var s = el.selectionStart, end = el.selectionEnd;
            el.value = el.value.slice(0, s) + normalized + el.value.slice(end);
            cb();
        }

        function matchesSearch(obj, query) {`;

if (!src.includes(OLD_FN)) { console.error('matchesSearch open not found'); process.exit(1); }
src = src.replace(OLD_FN, NEW_FN);

// 2. Add onpaste to the sims-search input
const OLD_INPUT = 'id="sims-search" type="text" placeholder="Search... (comma-separated for multiple)" oninput="renderSims()"';
const NEW_INPUT = 'id="sims-search" type="text" placeholder="Search... (comma-separated for multiple)" oninput="renderSims()" onpaste="normalizePastedSearch(this,event,renderSims)"';

if (!src.includes(OLD_INPUT)) { console.error('sims-search input not found'); process.exit(1); }
src = src.replace(OLD_INPUT, NEW_INPUT);

fs.writeFileSync(file, src.replace(/\n/g, '\r\n'));
console.log('done');
