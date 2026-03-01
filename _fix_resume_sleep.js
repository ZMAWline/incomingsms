'use strict';
// Fix: increase sleep after Resume On Cancel from 3s to 8s.
// Helix needs time to fully restore subscriber to Active before hxChangeImei
// will accept the request. 3s is sometimes not enough.
// Run: node _fix_resume_sleep.js

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src', 'mdn-rotator', 'index.js');
let src = fs.readFileSync(filePath, 'utf8');

src = src.replace(/\r\n/g, '\n');

const OLD =
  '    }, runId, iccid, "fix_resume"),\n' +
  '      { attempts: 3, label: `resume ${iccid}` }\n' +
  '    );\n' +
  '    await sleep(3000);';

const NEW =
  '    }, runId, iccid, "fix_resume"),\n' +
  '      { attempts: 3, label: `resume ${iccid}` }\n' +
  '    );\n' +
  '    await sleep(8000); // wait for Helix to restore subscriber to Active before Change IMEI';

if (!src.includes(OLD)) {
  console.error('ERROR: target block not found');
  process.exit(1);
}

src = src.replace(OLD, NEW);
console.log('\u2713 Sleep after Resume On Cancel increased from 3s to 8s');

const out = src.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, out, 'utf8');
console.log('\u2713 Written src/mdn-rotator/index.js');
