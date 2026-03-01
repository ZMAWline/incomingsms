'use strict';
// Fix: Helix returns ACTIVATED/SUSPENDED/CANCELED (uppercase), not Active/Suspended/Canceled.
// Update the helixStatusMap to cover both forms.
// Run: node _fix_ota_status_map.js

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src', 'mdn-rotator', 'index.js');
let src = fs.readFileSync(filePath, 'utf8');

src = src.replace(/\r\n/g, '\n');

const OLD =
  '          const helixStatusMap = { Active: "active", Suspended: "suspended", Canceled: "canceled" };';

const NEW =
  '          const helixStatusMap = { Active: "active", ACTIVE: "active", ACTIVATED: "active", Suspended: "suspended", SUSPENDED: "suspended", Canceled: "canceled", CANCELED: "canceled" };';

if (!src.includes(OLD)) {
  console.error('ERROR: helixStatusMap not found');
  process.exit(1);
}

src = src.replace(OLD, NEW);
console.log('\u2713 helixStatusMap updated to cover ACTIVATED/SUSPENDED/CANCELED uppercase forms');

const out = src.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, out, 'utf8');
console.log('\u2713 Written src/mdn-rotator/index.js');
