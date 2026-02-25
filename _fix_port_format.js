'use strict';
// Convert dot-notation ports from port-info ("06.01") to letter format ("6A")
// to match the sms-ingest convention stored in sims.port
const fs = require('fs');
const filePath = 'src/mdn-rotator/index.js';

let src = fs.readFileSync(filePath, 'utf8');
src = src.replace(/\r\n/g, '\n');

// 1. Add dotPortToLetter helper before scanGatewaysForIccid
const marker1 = 'async function scanGatewaysForIccid(env, iccid) {';
if (!src.includes(marker1)) throw new Error('scanGatewaysForIccid marker not found');
const helperFn =
  '// Convert port-info dot-notation ("06.01") to gateway letter format ("6A")\n' +
  'function dotPortToLetter(dotPort) {\n' +
  '  const parts = String(dotPort).split(\'.\');\n' +
  '  if (parts.length !== 2) return dotPort;\n' +
  '  const portNum = parseInt(parts[0], 10);\n' +
  '  const slotNum = parseInt(parts[1], 10);\n' +
  '  if (isNaN(portNum) || isNaN(slotNum) || slotNum < 1) return dotPort;\n' +
  '  return portNum + String.fromCharCode(64 + slotNum);\n' +
  '}\n\n';
src = src.replace(marker1, helperFn + marker1);

// 2. In scanGatewaysForIccid: convert found.port to letter format
const scan_old = 'if (found) return { gateway_id: gw.id, gateway_code: gw.code, port: found.port, current_imei: found.imei || null };';
const scan_new = 'if (found) return { gateway_id: gw.id, gateway_code: gw.code, port: dotPortToLetter(found.port), current_imei: found.imei || null };';
if (!src.includes(scan_old)) throw new Error('scan return marker not found');
src = src.replace(scan_old, scan_new);

// 3. In getUnoccupiedCandidates: convert p.port to letter format
const cand_old = 'candidates.push({ gateway_id: gw.id, gateway_code: gw.code, port: p.port, iccid: p.iccid, current_imei: p.imei || null });';
const cand_new = 'candidates.push({ gateway_id: gw.id, gateway_code: gw.code, port: dotPortToLetter(p.port), iccid: p.iccid, current_imei: p.imei || null });';
if (!src.includes(cand_old)) throw new Error('candidates push marker not found');
src = src.replace(cand_old, cand_new);

src = src.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, src, 'utf8');
console.log('Port format fix applied.');
