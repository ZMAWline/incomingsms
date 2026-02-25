const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

// ---- 1. Add "No Reseller" option in loadResellers ----
const DROPDOWN_OLD = "'<option value=\"\">All Resellers</option>' +";
const DROPDOWN_NEW = "'<option value=\"\">All Resellers</option><option value=\"none\">No Reseller</option>' +";
if (!content.includes(DROPDOWN_OLD)) throw new Error('DROPDOWN_OLD not found');
content = content.replace(DROPDOWN_OLD, DROPDOWN_NEW);
console.log('Dropdown option added');

// ---- 2. Guard against sending "none" as reseller_id param ----
const PARAM_OLD =
  '                if (resellerFilter) {\n' +
  '                    params.set(\'reseller_id\', resellerFilter);\n' +
  '                }';
const PARAM_NEW =
  '                if (resellerFilter && resellerFilter !== \'none\') {\n' +
  '                    params.set(\'reseller_id\', resellerFilter);\n' +
  '                }';
if (!content.includes(PARAM_OLD)) throw new Error('PARAM_OLD not found');
content = content.replace(PARAM_OLD, PARAM_NEW);
console.log('Param guard added');

// ---- 3. Apply no-reseller filter in renderSims ----
const RENDER_OLD = '  if (search) data = data.filter(s => matchesSearch(s, search));';
const RENDER_NEW =
  '  if (search) data = data.filter(s => matchesSearch(s, search));\n' +
  "  const resellerFilterVal = document.getElementById('filter-reseller')?.value;\n" +
  "  if (resellerFilterVal === 'none') data = data.filter(s => !s.reseller_id);";
if (!content.includes(RENDER_OLD)) throw new Error('RENDER_OLD not found');
content = content.replace(RENDER_OLD, RENDER_NEW);
console.log('renderSims filter added');

// ---- Write back with CRLF ----
content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Done!');
