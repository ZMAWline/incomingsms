'use strict';
const fs = require('fs');
const path = require('path');
const filePath = path.join(__dirname, 'src', 'dashboard', 'index.js');

let content = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');

// PROBLEM: api-tester div is nested inside tab-guide (wrong).
//
// Current file structure (at end of guide tab):
//
//   [16-space guide inner content]
//                 </div>            ← 16 spaces, closes inner guide section
//                 </div>
//
//             <div id="tab-api-tester"  ← WRONG: inside tab-guide
//             ...api-tester content...
//             </div>                ← closes api-tester (12 spaces)
//
//             </div>                ← closes tab-guide (12 spaces)
//
//             </div>                ← closes p-4 wrapper (12 spaces)
//         </main>
//
// Desired:
//
//                 </div>
//                 </div>
//
//             </div>                ← closes tab-guide (12 spaces)
//
//             <div id="tab-api-tester"
//             ...api-tester content...
//             </div>
//
//             </div>                ← closes p-4 wrapper
//         </main>
//
// Fix 1: add tab-guide closer BEFORE the api-tester start
const wrongInsert = '                </div>\n\n            <div id="tab-api-tester"';
const fixedInsert = '                </div>\n\n            </div>\n\n            <div id="tab-api-tester"';
if (!content.includes(wrongInsert)) throw new Error('Wrong-insert anchor not found');
content = content.replace(wrongInsert, fixedInsert);
console.log('✓ Inserted tab-guide closer before api-tester div');

// Fix 2: remove the now-redundant old tab-guide closer (which sits after api-tester).
// After fix 1, the tail looks like:
//   [api-tester closer]\n\n[old tab-guide closer]\n\n[wrapper closer]\n        </main>
// = 3x </div> → needs to be 2x </div>
const wrongTrail = '            </div>\n\n            </div>\n\n            </div>\n        </main>';
const fixedTrail = '            </div>\n\n            </div>\n        </main>';
if (!content.includes(wrongTrail)) throw new Error('Wrong-trail anchor not found');
content = content.replace(wrongTrail, fixedTrail);
console.log('✓ Removed duplicate tab-guide closer');

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Done.');
