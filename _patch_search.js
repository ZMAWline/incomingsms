const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, 'src/dashboard/index.js');
let src = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

// 1. Replace matchesSearch to support multi-term (comma/newline separated)
const OLD_FN = `        function matchesSearch(obj, query) {
            if (!query) return true;
            const q = query.toLowerCase();
            const DATE_FIELDS = ['activated_at','last_sms_received','last_mdn_rotated_at','created_at','updated_at'];
            const strings = Object.entries(obj).flatMap(([k, v]) => {
              if (v == null) return [];
              const base = String(v);
              if (DATE_FIELDS.includes(k) && v) {
                const d = new Date(v);
                if (!isNaN(d)) return [base, d.toLocaleDateString(), d.toLocaleString(), d.toISOString().slice(0,10)];
              }
              return [base];
            });
            return strings.some(s => s.toLowerCase().includes(q));
        }`;

const NEW_FN = `        function matchesSearch(obj, query) {
            if (!query) return true;
            const terms = query.split(/[\\n,;\\t]+/).map(t => t.trim().toLowerCase()).filter(Boolean);
            if (!terms.length) return true;
            const DATE_FIELDS = ['activated_at','last_sms_received','last_mdn_rotated_at','created_at','updated_at'];
            const strings = Object.entries(obj).flatMap(([k, v]) => {
              if (v == null) return [];
              const base = String(v);
              if (DATE_FIELDS.includes(k) && v) {
                const d = new Date(v);
                if (!isNaN(d)) return [base, d.toLocaleDateString(), d.toLocaleString(), d.toISOString().slice(0,10)];
              }
              return [base];
            });
            const lowerStrings = strings.map(s => s.toLowerCase());
            return terms.some(term => lowerStrings.some(s => s.includes(term)));
        }`;

if (!src.includes(OLD_FN)) { console.error('matchesSearch not found'); process.exit(1); }
src = src.replace(OLD_FN, NEW_FN);

// 2. Update placeholder text
const OLD_PH = 'placeholder="Search all fields..."';
const NEW_PH = 'placeholder="Search... (comma-separated for multiple)"';
if (!src.includes(OLD_PH)) { console.error('placeholder not found'); process.exit(1); }
src = src.replace(OLD_PH, NEW_PH);

fs.writeFileSync(file, src.replace(/\n/g, '\r\n'));
console.log('done');
