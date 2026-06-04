// _fix_bad_rentals_retiredline.js
// INC-6 follow-up: "Old MDN retired" line should ONLY render when the reported
// MDN is actually stale (reported !== current). When reported === current, the
// captured sim_numbers row may have a valid_to (the prior row got retired) but
// the SIM still has the same e164 — surfacing "Old MDN retired" is misleading.
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

const OLD1 = "mdnCell = '<span title=\"Reported and current MDN match — SIM has not rotated since report\" class=\"text-dark-200\">' + escapeHtml(reported) + '</span>' + retiredLine;";
const NEW1 = "mdnCell = '<span title=\"Reported and current MDN match — SIM has not rotated since report\" class=\"text-dark-200\">' + escapeHtml(reported) + '</span>';";

const OLD2 = "mdnCell = '<span title=\"Reported MDN; current MDN unknown (SIM has no active sim_numbers row)\" class=\"text-dark-300\">' + escapeHtml(reported) + '</span>' + retiredLine;";
const NEW2 = "mdnCell = '<span title=\"Reported MDN; current MDN unknown (SIM has no active sim_numbers row)\" class=\"text-dark-300\">' + escapeHtml(reported) + '</span>';";

if (!content.includes(OLD1)) { console.error('PATCH FAILED: OLD1 not found'); process.exit(1); }
if (!content.includes(OLD2)) { console.error('PATCH FAILED: OLD2 not found'); process.exit(1); }

content = content.replace(OLD1, NEW1).replace(OLD2, NEW2);

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch applied: retiredLine removed from non-stale branches.');
